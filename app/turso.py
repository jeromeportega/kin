"""A libsql-client → sqlite3-shaped adapter so kin's SQLite persistence layer
can talk to Turso (hosted libSQL) over HTTP.

Local dev and the entire test suite use stdlib ``sqlite3`` unchanged. When
``TURSO_DATABASE_URL`` is set (production / Vercel functions), ``db.connect()``
and ``cli_common.connect_db_ro()`` return a :class:`LibsqlConnection` instead —
the *same* ``db.py`` code then runs against Turso.

Only the ``sqlite3`` Connection/Cursor surface that ``db.py`` and its callers
actually use is implemented (surveyed across app/ ingest/ api/):

- ``execute`` / ``executemany`` / ``executescript``
- ``commit`` / ``rollback`` / ``close`` / ``cursor``
- ``row_factory`` (accepted for parity; libsql rows are already name-accessible)
- ``with conn:`` transactions — backed by a real libsql interactive transaction
  (``client.transaction()``), so a block can read ``cursor.lastrowid`` mid-flight
  and use it in later writes (e.g. ``insert_digest``)
- ``Cursor.lastrowid`` / ``rowcount`` / ``fetchone`` / ``fetchall`` / iteration

libsql-client rows support both positional (``row[0]``) and name (``row["x"]``)
access plus ``keys()``, so they pass through unwrapped.

The driver is the pure-Python ``libsql-client`` (HTTP). The native
``libsql-experimental`` was rejected: it has no ``row_factory`` or connection
context-manager protocol and returns bare tuples, and it fails to build on
Python 3.14.
"""
from __future__ import annotations

from typing import Any, Iterable, Sequence


def _http_url(url: str) -> str:
    """Turso hands out ``libsql://`` URLs; the sync HTTP client wants ``https://``."""
    if url.startswith("libsql://"):
        return "https://" + url[len("libsql://") :]
    return url


def _split_script(script: str) -> list[str]:
    """Split an ``executescript`` payload into individual statements.

    kin's schema is plain DDL with no ``;`` inside string or identifier literals,
    so a naive split is safe and keeps the adapter dependency-free.
    """
    return [s.strip() for s in script.split(";") if s.strip()]


class _Cursor:
    """Minimal ``sqlite3.Cursor`` stand-in backed by a libsql ResultSet."""

    def __init__(self, conn: "LibsqlConnection") -> None:
        self._conn = conn
        self._rows: list[Any] = []
        self._idx = 0
        self.lastrowid: int | None = None
        self.rowcount: int = -1

    def execute(self, sql: str, params: Sequence[Any] = ()) -> "_Cursor":
        self._load(self._conn._exec(sql, params))
        return self

    def executemany(self, sql: str, seq_of_params: Iterable[Sequence[Any]]) -> "_Cursor":
        result = None
        for params in seq_of_params:
            result = self._conn._exec(sql, params)
        self._load(result)
        return self

    def _load(self, result: Any) -> None:
        rows = getattr(result, "rows", None)
        self._rows = list(rows) if rows is not None else []
        self._idx = 0
        self.lastrowid = getattr(result, "last_insert_rowid", None)
        self.rowcount = getattr(result, "rows_affected", -1)

    def fetchone(self) -> Any | None:
        if self._idx >= len(self._rows):
            return None
        row = self._rows[self._idx]
        self._idx += 1
        return row

    def fetchall(self) -> list[Any]:
        rows = self._rows[self._idx :]
        self._idx = len(self._rows)
        return rows

    def __iter__(self):
        return iter(self.fetchall())


class LibsqlConnection:
    """A ``sqlite3.Connection``-shaped wrapper over a libsql-client ClientSync."""

    def __init__(self, url: str, auth_token: str) -> None:
        import libsql_client  # lazy: only needed on the Turso path

        self._client = libsql_client.create_client_sync(
            url=_http_url(url), auth_token=auth_token
        )
        self._tx: Any | None = None  # active interactive transaction within `with conn:`
        self.row_factory: Any = None  # accepted for parity; rows are already name-accessible

    # --- statement execution -------------------------------------------------
    def _exec(self, sql: str, params: Sequence[Any] = ()) -> Any:
        target = self._tx if self._tx is not None else self._client
        if params:
            return target.execute(sql, list(params))
        return target.execute(sql)

    def execute(self, sql: str, params: Sequence[Any] = ()) -> _Cursor:
        return _Cursor(self).execute(sql, params)

    def executemany(self, sql: str, seq_of_params: Iterable[Sequence[Any]]) -> _Cursor:
        return _Cursor(self).executemany(sql, seq_of_params)

    def executescript(self, script: str) -> None:
        # Each statement is run on its own; DDL here is idempotent. (A future
        # optimization could batch these into one round-trip via client.batch.)
        for stmt in _split_script(script):
            self._exec(stmt)

    def cursor(self) -> _Cursor:
        return _Cursor(self)

    # --- transactions --------------------------------------------------------
    def commit(self) -> None:
        if self._tx is not None:
            self._tx.commit()
            self._tx = None

    def rollback(self) -> None:
        if self._tx is not None:
            self._tx.rollback()
            self._tx = None

    def __enter__(self) -> "LibsqlConnection":
        # Mirror sqlite3's `with conn:` — commit on success, roll back on error.
        self._tx = self._client.transaction()
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if self._tx is not None:
            if exc_type is None:
                self._tx.commit()
            else:
                self._tx.rollback()
            self._tx = None
        return False

    def close(self) -> None:
        if self._tx is not None:
            try:
                self._tx.rollback()
            except Exception:
                pass
            self._tx = None
        self._client.close()


def connect(url: str, auth_token: str) -> LibsqlConnection:
    """Open a Turso connection presenting the sqlite3 surface kin relies on."""
    return LibsqlConnection(url, auth_token)

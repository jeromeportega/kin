"""A libsql-client → sqlite3-shaped adapter so kin's SQLite persistence layer
can talk to Turso (hosted libSQL) over HTTP.

Local dev and the entire test suite use stdlib ``sqlite3`` unchanged. When
``TURSO_DATABASE_URL`` is set (production / Vercel functions), ``db.connect()``
and ``cli_common.connect_db_ro()`` return a :class:`LibsqlConnection` instead —
the *same* ``db.py`` code then runs against Turso.

**Transactions.** The libsql HTTP transport does not support *interactive*
transactions (``TRANSACTIONS_NOT_SUPPORTED``), and the WebSocket transport's sync
client spawns a background thread that hangs at process exit — bad for a
serverless function that must return cleanly. So this adapter stays on HTTP and
runs statements eagerly:

- a single ``execute`` autocommits;
- ``executemany`` and ``executescript`` run as one atomic ``batch()``.

``with conn:`` is therefore a no-op wrapper. That is fully atomic for every
single-statement unit in kin (start_run, upsert_email, insert_classification,
finish_run, …). The one multi-statement unit, ``insert_digest``, commits the
digest row then atomically batches its items; a failure in between would leave an
itemless digest — harmless, and regenerated on the next digest run.

Driver: pure-Python ``libsql-client`` (HTTP). ``libsql-experimental`` was
rejected (no ``row_factory``/context-manager, bare-tuple rows, fails to build on
Python 3.14). Its rows already support positional ``row[0]`` and name
``row["x"]`` access, so they pass through unwrapped. libsql errors are
translated to ``sqlite3`` errors so existing ``except sqlite3.*`` clauses fire.
"""
from __future__ import annotations

import sqlite3
from typing import Any, Iterable, Sequence


def _http_url(url: str) -> str:
    """Turso hands out ``libsql://`` URLs; the HTTP client wants ``https://``."""
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
        self._load(self._conn._execute_one(sql, params))
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

        self._libsql = libsql_client
        self._client = libsql_client.create_client_sync(
            url=_http_url(url), auth_token=auth_token
        )
        self.row_factory: Any = None  # accepted for parity; rows are already name-accessible

    def _translate(self, exc: Exception) -> sqlite3.Error:
        # Map libsql errors onto sqlite3 so existing `except sqlite3.*` clauses
        # in db.py / triage.py keep working on the Turso path.
        return sqlite3.OperationalError(str(exc))

    def _execute_one(self, sql: str, params: Sequence[Any] = ()) -> Any:
        try:
            if params:
                return self._client.execute(sql, list(params))
            return self._client.execute(sql)
        except self._libsql.LibsqlError as exc:
            raise self._translate(exc) from exc

    def _batch(self, statements: list[Any]) -> None:
        try:
            self._client.batch(statements)
        except self._libsql.LibsqlError as exc:
            raise self._translate(exc) from exc

    def execute(self, sql: str, params: Sequence[Any] = ()) -> _Cursor:
        return _Cursor(self).execute(sql, params)

    def executemany(self, sql: str, seq_of_params: Iterable[Sequence[Any]]) -> _Cursor:
        stmts = [(sql, list(p)) for p in seq_of_params]
        if stmts:
            self._batch(stmts)
        return _Cursor(self)

    def executescript(self, script: str) -> None:
        stmts = _split_script(script)
        if stmts:
            self._batch(stmts)

    def cursor(self) -> _Cursor:
        return _Cursor(self)

    # `with conn:` is a no-op — statements already autocommit (see module docstring).
    def __enter__(self) -> "LibsqlConnection":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False

    def commit(self) -> None:  # autocommit — nothing to flush
        pass

    def rollback(self) -> None:  # cannot undo autocommitted statements
        pass

    def close(self) -> None:
        self._client.close()


def connect(url: str, auth_token: str) -> LibsqlConnection:
    """Open a Turso connection presenting the sqlite3 surface kin relies on."""
    return LibsqlConnection(url, auth_token)

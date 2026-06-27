"""Unit tests for the libsql-client → sqlite3 adapter (app/turso.py).

These run offline in the gate: a fake libsql client backed by in-memory sqlite3
stands in for the real ClientSync, so we exercise the adapter's translation
logic (execute autocommit, executemany/executescript via batch, name-accessible
rows, lastrowid, sqlite3 error mapping) without hitting the network. A separate
live smoke against real Turso is run manually (scripts/turso_smoke.py).
"""
import sqlite3

import pytest

from app.turso import LibsqlConnection, _http_url, _split_script


def _result(cur):
    try:
        rows = cur.fetchall()
    except sqlite3.ProgrammingError:
        rows = []

    class _R:
        pass

    r = _R()
    r.rows = rows
    r.last_insert_rowid = cur.lastrowid
    r.rows_affected = cur.rowcount
    return r


class _FakeClient:
    """Mimics libsql-client ClientSync, backed by a single in-memory sqlite3."""

    def __init__(self):
        self._conn = sqlite3.connect(":memory:")
        self._conn.row_factory = sqlite3.Row

    def execute(self, sql, args=None):
        cur = self._conn.execute(sql, list(args) if args else [])
        self._conn.commit()
        return _result(cur)

    def batch(self, stmts):
        for s in stmts:
            if isinstance(s, tuple):
                sql, args = s
                self._conn.execute(sql, list(args) if args else [])
            else:
                self._conn.execute(s)
        self._conn.commit()

    def close(self):
        self._conn.close()


@pytest.fixture
def conn(monkeypatch):
    import libsql_client

    fake = _FakeClient()
    monkeypatch.setattr(libsql_client, "create_client_sync", lambda **kw: fake)
    c = LibsqlConnection("libsql://example", "token")
    c.executescript("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); ")
    return c


def test_http_url_rewrites_only_libsql_scheme():
    assert _http_url("libsql://db.turso.io") == "https://db.turso.io"
    assert _http_url("https://db.turso.io") == "https://db.turso.io"


def test_split_script_drops_blanks():
    assert _split_script("A;  B ;; C ;") == ["A", "B", "C"]


def test_execute_returns_name_accessible_rows(conn):
    conn.execute("INSERT INTO t (name) VALUES (?)", ("alice",))
    row = conn.execute("SELECT id, name FROM t").fetchone()
    assert row["name"] == "alice"
    assert row[0] == 1


def test_lastrowid_after_insert(conn):
    cur = conn.execute("INSERT INTO t (name) VALUES (?)", ("bob",))
    assert cur.lastrowid == 1


def test_with_conn_autocommits(conn):
    # The HTTP transport has no interactive transactions; `with conn:` is a no-op
    # and statements autocommit (see app/turso.py).
    with conn:
        conn.execute("INSERT INTO t (name) VALUES (?)", ("carol",))
    assert conn.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 1


def test_mid_block_lastrowid_then_batch(conn):
    # The insert_digest pattern: autocommit an insert, read lastrowid, then batch
    # the dependent rows via executemany.
    with conn:
        cur = conn.execute("INSERT INTO t (name) VALUES (?)", ("parent",))
        pid = cur.lastrowid
        conn.executemany("INSERT INTO t (name) VALUES (?)", [(f"child-{pid}",)])
    names = [r["name"] for r in conn.execute("SELECT name FROM t ORDER BY id").fetchall()]
    assert names == ["parent", "child-1"]


def test_executemany_via_batch(conn):
    conn.executemany("INSERT INTO t (name) VALUES (?)", [("a",), ("b",)])
    rows = conn.execute("SELECT name FROM t ORDER BY id").fetchall()
    assert [r["name"] for r in rows] == ["a", "b"]


def test_libsql_error_maps_to_sqlite3(monkeypatch):
    import libsql_client

    class _Boom:
        def execute(self, *a, **k):
            raise libsql_client.LibsqlError("boom", "GENERIC")

        def close(self):
            pass

    monkeypatch.setattr(libsql_client, "create_client_sync", lambda **kw: _Boom())
    c = LibsqlConnection("libsql://x", "t")
    with pytest.raises(sqlite3.Error):
        c.execute("SELECT 1")

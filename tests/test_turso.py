"""Unit tests for the libsql-client → sqlite3 adapter (app/turso.py).

These run offline in the gate: a fake libsql client backed by in-memory sqlite3
stands in for the real ClientSync, so we exercise the adapter's translation
logic (execute routing, executescript, `with conn:` transactions, lastrowid,
name-accessible rows) without hitting the network. A separate live smoke test
against real Turso is run manually (see scripts/turso_smoke.py).
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


class _FakeTx:
    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, args=None):
        return _result(self._conn.execute(sql, list(args) if args else []))

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        pass


class _FakeClient:
    """Mimics libsql-client ClientSync, backed by a single in-memory sqlite3."""

    def __init__(self):
        self._conn = sqlite3.connect(":memory:")
        self._conn.row_factory = sqlite3.Row

    def execute(self, sql, args=None):
        cur = self._conn.execute(sql, list(args) if args else [])
        self._conn.commit()
        return _result(cur)

    def transaction(self):
        return _FakeTx(self._conn)

    def batch(self, stmts):
        for s in stmts:
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


def test_with_conn_commits_on_success(conn):
    with conn:
        conn.execute("INSERT INTO t (name) VALUES (?)", ("carol",))
    assert conn.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 1


def test_with_conn_rolls_back_on_error(conn):
    with pytest.raises(ValueError):
        with conn:
            conn.execute("INSERT INTO t (name) VALUES (?)", ("doomed",))
            raise ValueError("boom")
    assert conn.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 0


def test_mid_transaction_lastrowid(conn):
    # The insert_digest pattern: read lastrowid mid-transaction, use it downstream.
    with conn:
        cur = conn.execute("INSERT INTO t (name) VALUES (?)", ("parent",))
        pid = cur.lastrowid
        conn.executemany("INSERT INTO t (name) VALUES (?)", [(f"child-{pid}",)])
    names = [r["name"] for r in conn.execute("SELECT name FROM t ORDER BY id").fetchall()]
    assert names == ["parent", "child-1"]


def test_fetchall_then_iterate(conn):
    conn.executemany("INSERT INTO t (name) VALUES (?)", [("a",), ("b",)])
    rows = conn.execute("SELECT name FROM t ORDER BY id").fetchall()
    assert [r["name"] for r in rows] == ["a", "b"]

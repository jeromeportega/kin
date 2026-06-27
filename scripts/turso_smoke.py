"""Live smoke test of the Turso adapter against a real Turso database.

Run manually (NOT part of the gate — it needs network + Turso creds):

    set -a; . ./.env.turso; set +a
    uv run python scripts/turso_smoke.py

Verifies, end-to-end against real Turso: db.connect() runs init_schema through
the adapter (executescript of the full schema + _meta), then a scratch
round-trip exercising `with conn:` commit, rollback, mid-transaction lastrowid,
and name-accessible rows.
"""
import os
import sys

from app import db


def main() -> int:
    if not os.environ.get("TURSO_DATABASE_URL"):
        print("TURSO_DATABASE_URL not set — `set -a; . ./.env.turso; set +a` first")
        return 1

    # db.connect() takes the Turso branch and runs init_schema against Turso —
    # this alone exercises executescript + _meta reads/writes through the adapter.
    conn = db.connect("ignored-on-turso")
    print("connected + init_schema OK against Turso")

    conn.executescript(
        "CREATE TABLE IF NOT EXISTS _smoke (id INTEGER PRIMARY KEY, name TEXT); DELETE FROM _smoke;"
    )

    # commit + mid-transaction lastrowid (the insert_digest pattern)
    with conn:
        cur = conn.execute("INSERT INTO _smoke (name) VALUES (?)", ("parent",))
        pid = cur.lastrowid
        conn.executemany("INSERT INTO _smoke (name) VALUES (?)", [(f"child-{pid}",)])
    names = [r["name"] for r in conn.execute("SELECT id, name FROM _smoke ORDER BY id").fetchall()]
    assert names == ["parent", "child-1"], names

    # rollback on error leaves the table untouched
    try:
        with conn:
            conn.execute("INSERT INTO _smoke (name) VALUES (?)", ("doomed",))
            raise RuntimeError("intentional")
    except RuntimeError:
        pass
    count = conn.execute("SELECT COUNT(*) FROM _smoke").fetchone()[0]
    assert count == 2, count

    conn.execute("DROP TABLE _smoke")
    conn.close()
    print(f"round-trip OK — commit+tx+lastrowid+rows-by-name {names}; rollback left {count} rows")
    print("TURSO SMOKE PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())

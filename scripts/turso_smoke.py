"""Live smoke test of the Turso adapter against a real Turso database.

Run manually (NOT part of the gate — it needs network + Turso creds):

    set -a; . ./.env.turso; set +a
    uv run python scripts/turso_smoke.py

Verifies, end-to-end against real Turso: db.connect() runs init_schema through
the adapter (executescript → atomic batch, _meta reads/writes), then a scratch
round-trip exercising autocommit, mid-block lastrowid, executemany → batch, and
name-accessible rows.
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

    # autocommit + mid-block lastrowid + executemany→batch (the insert_digest pattern)
    with conn:
        cur = conn.execute("INSERT INTO _smoke (name) VALUES (?)", ("parent",))
        pid = cur.lastrowid
        conn.executemany("INSERT INTO _smoke (name) VALUES (?)", [(f"child-{pid}",)])
    names = [r["name"] for r in conn.execute("SELECT id, name FROM _smoke ORDER BY id").fetchall()]
    assert names == ["parent", "child-1"], names

    conn.execute("DROP TABLE _smoke")
    conn.close()
    print(f"round-trip OK — init_schema + autocommit + lastrowid + batch + rows-by-name {names}")
    print("TURSO SMOKE PASS")
    # libsql-client's sync client leaves a background thread that blocks a clean
    # exit; hard-exit now that the work (and conn.close) is done.
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    sys.exit(main())

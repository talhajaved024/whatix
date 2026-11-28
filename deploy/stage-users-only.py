"""Stage a fresh Whatix v1 data directory from the production users table."""
import argparse
import os
import sqlite3
from contextlib import closing
from pathlib import Path


def stage(source, target):
    source = source.resolve(strict=True)
    target = target.resolve()
    if target.is_relative_to(source.parent):
        raise ValueError("Choose a new staging directory outside the source data directory.")
    tables = {"users", "assigned_numbers", "offline requirements", "intake_context",
              "app_records", "away_replies"}
    target.mkdir(exist_ok=False)
    output = target / "whatix.db"
    with closing(sqlite3.connect(output.as_uri(), uri=True)) as db, db:
        db.execute("ATTACH DATABASE ? AS old", (source.as_uri() + "?mode=ro",))
        db.execute("BEGIN")
        if db.execute("PRAGMA old.user_version").fetchone() != (1,):
            raise ValueError("Unrecognized schema version; review the production schema.")
        objects = db.execute("""
            SELECT type, name, sql FROM old.sqlite_master
            WHERE name NOT GLOB 'sqlite_*' ORDER BY rowid
        """).fetchall()
        if {(kind, name) for kind, name, _ in objects} != {("table", t) for t in tables}:
            raise ValueError("Unexpected schema objects; review before staging.")
        for _, _, ddl in objects:
            db.execute(ddl)
        db.execute("INSERT INTO main.users SELECT * FROM old.users")
        db.execute("DELETE FROM main.sqlite_sequence WHERE name='users'")
        db.execute("""INSERT INTO main.sqlite_sequence(name, seq)
                      SELECT name, seq FROM old.sqlite_sequence WHERE name='users'""")
        db.execute("PRAGMA main.user_version=1")
        count = db.execute("SELECT COUNT(*) FROM main.users").fetchone()[0]
        if not count or not db.execute("SELECT 1 FROM main.users WHERE IS_ADMIN=1").fetchone():
            raise ValueError("No accounts or administrator found.")
        for a, b in [("main", "old"), ("old", "main")]:
            if db.execute(f"SELECT * FROM {a}.users EXCEPT SELECT * FROM {b}.users").fetchone():
                raise ValueError("Account verification failed.")
        for table in tables - {"users"}:
            if db.execute(f'SELECT 1 FROM main."{table}" LIMIT 1').fetchone():
                raise ValueError("Business data present in staged database.")
        if db.execute("PRAGMA main.integrity_check").fetchall() != [("ok",)]:
            raise ValueError("Staged database integrity check failed.")
    return count


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("new_directory", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    accounts = stage(args.source, args.new_directory)
    print(f"Staged and verified {accounts} accounts; all business tables are empty.")

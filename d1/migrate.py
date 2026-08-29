#!/usr/bin/env python3
"""D1 Migration Helper

Reads schema.sql and outputs Wrangler-compatible migration commands.
Usage:
    python migrate.py --local
    python migrate.py --remote
"""

import argparse
import sqlite3
import sys
from pathlib import Path


def read_schema() -> str:
    schema_path = Path(__file__).parent / "schema.sql"
    if not schema_path.exists():
        print(f"Error: {schema_path} not found", file=sys.stderr)
        sys.exit(1)
    return schema_path.read_text()


def apply_local(db_path: str = "local.db") -> None:
    """Apply schema to a local SQLite database for testing."""
    schema = read_schema()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.executescript(schema)
    conn.commit()
    conn.close()
    print(f"Schema applied to {db_path}")


def print_wrangler_commands() -> None:
    """Print Wrangler D1 migration commands."""
    schema = read_schema()
    print("# Wrangler D1 migration commands")
    print("# First, create the database (one-time):")
    print("#   npx wrangler d1 create ai-news-db")
    print()
    print("# Apply schema via Wrangler:")
    print("#   npx wrangler d1 execute ai-news-db --file=./d1/schema.sql")
    print()
    print("# For local development:")
    print("#   npx wrangler d1 execute ai-news-db --local --file=./d1/schema.sql")
    print()
    print("--- Schema Preview ---")
    print(schema[:500] + "..." if len(schema) > 500 else schema)


def main() -> None:
    parser = argparse.ArgumentParser(description="D1 Migration Helper")
    parser.add_argument("--local", action="store_true", help="Apply to local SQLite DB")
    parser.add_argument("--db-path", default="local.db", help="Local DB path")
    parser.add_argument("--wrangler", action="store_true", help="Print Wrangler commands")
    args = parser.parse_args()

    if args.local:
        apply_local(args.db_path)
    elif args.wrangler:
        print_wrangler_commands()
    else:
        print_wrangler_commands()


if __name__ == "__main__":
    main()

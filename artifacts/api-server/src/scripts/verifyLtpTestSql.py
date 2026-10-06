"""Run isolated LTP test-tool SQL checks. Requires an empty UTF-8 PostgreSQL DB.

Usage: python3 src/scripts/verifyLtpTestSql.py <psql connection arguments>
Never point this at Supabase or the application's database. It creates fixtures.
"""
import pathlib
import argparse
import re
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--help", action="help")
parser.add_argument("-h", dest="host", required=True, choices=["/tmp", "localhost", "127.0.0.1"])
parser.add_argument("-p", dest="port", required=True)
parser.add_argument("-U", dest="user", required=True)
parser.add_argument("-d", dest="database", required=True)
args = parser.parse_args()
if not args.database.startswith("ltp_"):
    parser.error("Use an empty synthetic database whose name starts with ltp_")
connection = ["-h", args.host, "-p", args.port, "-U", args.user, "-d", args.database]
safe = subprocess.check_output([
    "psql", "-X", "-tA", *connection, "-c",
    "SELECT current_setting('server_encoding')='UTF8' AND NOT EXISTS("
    "SELECT 1 FROM pg_tables WHERE schemaname='public')",
], text=True).strip()
if safe != "t":
    raise RuntimeError("The fixture requires an EMPTY UTF-8 synthetic database")
source = (root / "migrations/013_retention_ltp_sequence.sql").read_text()
functions = []
for name in [
    "retention_sequence_save_batch", "retention_sequence_claim",
    "retention_sequence_record_send", "retention_sequence_transition",
    "retention_sequence_due_step2",
]:
    match = re.search(r"CREATE OR REPLACE FUNCTION public\." + name + r"\([\s\S]*?\$\$;", source)
    if not match:
        raise RuntimeError(f"Missing installed-source fixture function: {name}")
    functions.append(match.group())

with tempfile.TemporaryDirectory(prefix="ltp-test-sql-") as directory:
    original = pathlib.Path(directory) / "original.sql"
    original.write_text("\n".join(functions))
    fixture = root / "src/lib/__tests__/sql/ltpTestTools.fixture.sql"
    # Roles can exist on a shared local test server. All application data lives
    # in the explicitly supplied empty synthetic database.
    role_safe = pathlib.Path(directory) / "fixture.sql"
    role_safe.write_text(re.sub(
        r"CREATE ROLE (\w+);",
        r"DO $$ BEGIN CREATE ROLE \1; EXCEPTION WHEN duplicate_object THEN NULL; END $$;",
        fixture.read_text(),
    ))
    subprocess.run([
        "psql", "-X", "-v", "ON_ERROR_STOP=1", *connection,
        "-f", str(role_safe), "-f", str(original),
        "-f", str(root / "migrations/015_ltp_test_tools.sql"),
        "-f", str(root / "src/lib/__tests__/sql/ltpTestTools.assert.sql"),
    ], check=True)

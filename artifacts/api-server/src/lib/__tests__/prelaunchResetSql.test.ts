import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("real PostgreSQL reset replacement preserves history and refuses send/approval evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "prelaunch-reset-sql-"));
  const data = join(root, "data");
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${command}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  let started = false;
  try {
    run("initdb", ["-D", data, "-U", "fixture_owner", "-A", "trust", "-E", "UTF8", "--no-locale"]);
    run("pg_ctl", ["-D", data, "-l", join(root, "server.log"),
      "-o", `-k ${root} -p 55440 -c listen_addresses=''`, "-w", "start"]);
    started = true;
    const sql = (path: string) => run("psql", ["-h", root, "-p", "55440", "-U", "fixture_owner", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-f", path]);
    sql(new URL("./sql/ltpTestTools.fixture.sql", import.meta.url).pathname);
    const migration = readFileSync(new URL("../../../migrations/013_retention_ltp_sequence.sql", import.meta.url), "utf8");
    const functions = new Map([...migration.matchAll(
      /CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?\$\$;/g,
    )].map(match => [match[1], match[0]]));
    const writer = functions.get("retention_sequence_save_batch")!;
    assert.ok(writer, "the test must exercise the real transactional writer");
    const native = [
      "retention_create_candidate", "retention_sequence_save_batch",
      "retention_sequence_transition", "retention_sequence_record_send", "retention_sequence_due_step2",
    ].map(name => {
      const source = functions.get(name);
      assert.ok(source, name);
      return source;
    }).join("\n");
    const fixture = join(root, "native.sql");
    writeFileSync(fixture, native + "\n" + writer.replace(
      "public.retention_sequence_save_batch(", "public.retention_sequence_save_batch_test(",
    ));
    sql(fixture);
    const change = new URL("../../../migrations/018_prelaunch_reset_replacements.sql", import.meta.url).pathname;
    sql(change);
    sql(change); // Reinstallation is idempotent, including source amendments.
    const outcome = sql(new URL("./sql/prelaunchReset.assert.sql", import.meta.url).pathname);
    assert.match(outcome.stderr, /all original candidate fields unchanged/);
    assert.match(outcome.stderr, /second generation cannot duplicate replacement/);
    assert.match(outcome.stderr, /later sequence transition preserves archived candidate fields/);
  } finally {
    if (started) spawnSync("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], { encoding: "utf8" });
    rmSync(root, { recursive: true, force: true });
  }
});

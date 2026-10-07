import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

/** Socket-only disposable cluster: never reads a workspace database URL. */
export function operatorPostgresFixture() {
  const root = mkdtempSync(join(tmpdir(), "operator-postgres-"));
  const data = join(root, "data");
  const run = (cmd: string, args: string[]) => {
    const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
    return result;
  };
  const connection = ["-h", root, "-p", "55442", "-U", "fixture_owner", "-d", "postgres", "-v", "ON_ERROR_STOP=1"];
  let started = false;
  const close = () => {
    if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    started = false;
    rmSync(root, { recursive: true, force: true });
  };
  const sql = (source: string) => run("psql", [...connection, "-At", "-c", source]).stdout.trim();
  try {
    run("initdb", ["-D", data, "-U", "fixture_owner", "-A", "trust", "--no-locale", "-E", "UTF8"]);
    run("pg_ctl", ["-D", data, "-l", join(root, "postgres.log"),
      "-o", `-k ${root} -p 55442 -c listen_addresses=''`, "-w", "start"]);
    started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE clubs(id uuid PRIMARY KEY,slug text,sms_kill_switch boolean);
      INSERT INTO clubs VALUES('00000000-0000-4000-8000-000000000001','pb-club',true);`);
    const migrate = (file: string) => run("psql", [...connection, "-f",
      new URL("../../../../migrations/" + file, import.meta.url).pathname]);
    migrate("017_operator_runtime.sql");
    sql("INSERT INTO operator_runtime(name,result) VALUES('kill-switch','paused')");
    migrate("020_operator_alert_incidents.sql");
    migrate("020_operator_alert_incidents.sql"); // Reapplication must remain safe.
    return { root, connection, sql, close };
  } catch (error) {
    close();
    throw error;
  }
}

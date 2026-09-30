/**
 * npm run snapshot — live Supabase + source + Git, never project memory.
 *
 * Optional full catalog access: install scripts/snapshot-metadata.sql in
 * Supabase SQL Editor. Without it, use service-role PostgREST OpenAPI and
 * clearly report unavailable catalog/migration coverage.
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supabase } from "../artifacts/api-server/src/lib/supabaseClient";
import { collectSource } from "./snapshot-source";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "PLATFORM_STATE.md");
const MAX_LINES = 1490;

type Column = { name: string; type: string };
type Table = { name: string; columns: Column[]; count?: number; countError?: string };
type LedgerRow = Record<string, string | number | null>;
type Metadata = {
  tables: Table[];
  migration_source: string | null;
  migrations: LedgerRow[];
};
const warnings: string[] = [];

// Markdown cell escaping keeps source comments/commit subjects on one line.
function cell(value: unknown): string {
  return String(value ?? "—").replace(/\r?\n/g, " ").replace(/\|/g, "\\|")
    .replace(/`/g, "'").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function code(value: unknown): string { return `\`${cell(value)}\``; }
function safeError(error: { code?: string } | null | undefined): string {
  return error?.code ?? "request failed";
}
function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8_000_000 }).trim();
}
async function mapLimit<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      result[index] = await fn(values[index]);
    }
  }));
  return result;
}

async function openApiTables(): Promise<Table[]> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/openapi+json", "Accept-Profile": "public" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Schema OpenAPI request failed (HTTP ${response.status}).`);
  const doc = await response.json() as {
    definitions?: Record<string, { properties?: Record<string, { format?: string; type?: string }> }>;
    paths?: Record<string, unknown>;
  };
  if (!doc.definitions) throw new Error("Supabase OpenAPI did not contain table definitions.");
  // Ignore RPC argument/result definitions; table endpoints have a root path.
  return Object.entries(doc.definitions)
    .filter(([name]) => doc.paths?.[`/${name}`])
    .map(([name, definition]) => ({
      name, columns: Object.entries(definition.properties ?? {}).map(([column, schema]) => ({
        name: column, type: schema.format ?? schema.type ?? "unknown",
      })),
    })).sort((a, b) => a.name.localeCompare(b.name));
}

async function readMetadata(): Promise<{ metadata: Metadata; fullCatalog: boolean }> {
  const rpc = await supabase.rpc("platform_snapshot_metadata");
  if (!rpc.error && rpc.data) {
    const data = rpc.data as Metadata;
    if (!Array.isArray(data.tables) || !Array.isArray(data.migrations)) {
      throw new Error("platform_snapshot_metadata returned an invalid response.");
    }
    data.tables.sort((a, b) => a.name.localeCompare(b.name));
    return { metadata: data, fullCatalog: true };
  }
  if (rpc.error?.code !== "PGRST202" && rpc.error?.code !== "42883") {
    warnings.push(`Full-catalog metadata RPC unavailable (${safeError(rpc.error)}).`);
  }
  warnings.push(
    "Catalog coverage is limited to public relations exposed to the service role by PostgREST. " +
    "Unexposed tables cannot be discovered, and OpenAPI may include views. Install scripts/snapshot-metadata.sql for every public base table.",
  );
  const tables = await openApiTables();
  const ledger = tables.find(t => ["schema_migrations", "migrations", "_prisma_migrations"].includes(t.name));
  let migrations: LedgerRow[] = [];
  let migrationSource: string | null = null;
  if (ledger) {
    const names = ledger.columns.map(c => c.name).filter(n =>
      ["version", "name", "id", "migration_name", "applied_at", "executed_at", "finished_at", "rolled_back_at"].includes(n));
    if (names.length) {
      migrations = await readAll<LedgerRow>(ledger.name, names.join(","));
      migrationSource = `public.${ledger.name}`;
    }
  }
  return { metadata: { tables, migrations, migration_source: migrationSource }, fullCatalog: false };
}

async function readAll<T>(table: string, select: string): Promise<T[]> {
  const rows: T[] = [];
  const size = 500;
  for (let start = 0; ; start += size) {
    const response = await supabase.from(table).select(select, { count: "exact" }).range(start, start + size - 1);
    if (response.error) throw new Error(`Reading public.${table} failed (${safeError(response.error)}).`);
    rows.push(...response.data as unknown as T[]);
    if (rows.length >= (response.count ?? Infinity) || !response.data?.length) break;
  }
  return rows;
}

// Discover SQL migration files from the repository, not notes or remembered state.
async function migrationFiles(): Promise<string[]> {
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0");
  return [...new Set(files.filter(f =>
    /\.sql$/i.test(f) && /(^|\/)migrations?\//i.test(f) &&
    !/(^|\/)(node_modules|\.agents|\.local)\//.test(f)))].sort();
}
function groupedColumns(columns: Column[]): string {
  const groups = new Map<string, string[]>();
  for (const column of columns) groups.set(column.type, [...(groups.get(column.type) ?? []), column.name]);
  return [...groups].map(([type, names]) => `${code(type)}: ${names.map(code).join(", ")}`).join("; ");
}
function tableLines(table: Table, compact: boolean): string[] {
  const count = table.countError ? `UNAVAILABLE (${table.countError})` : table.count?.toLocaleString("en-US");
  if (compact || table.columns.length > 15) {
    return [`- **public.${cell(table.name)}** — ${count} rows; ${table.columns.length} columns. ${groupedColumns(table.columns)}`];
  }
  return [
    `### public.${cell(table.name)}`, `Live rows: **${count}**`, "",
    "| Column | PostgreSQL type |", "| --- | --- |",
    ...table.columns.map(c => `| ${code(c.name)} | ${code(c.type)} |`), "",
  ];
}
type Job = { id: string; status: string; started_at: string | null; finished_at: string | null };
function duration(job: Job, generatedAt: string): string {
  if (!job.started_at) return "Never run";
  if (!job.finished_at && job.status !== "running") return "Unknown (no finish time)";
  const seconds = (Date.parse(job.finished_at ?? generatedAt) - Date.parse(job.started_at)) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return "Invalid timestamps";
  return `${seconds.toFixed(3)} s${job.finished_at ? "" : " (elapsed, still running)"}`;
}
function ledgerLines(metadata: Metadata): string[] {
  const lines = ["## Applied migrations", ""];
  if (!metadata.migration_source) {
    warnings.push("Applied migrations are UNKNOWN: no readable migration ledger was found. SQL filenames and existing columns do not prove a migration ran.");
    lines.push(
      "**UNKNOWN — no readable migration ledger.** Manual SQL Editor runs may never have been recorded.",
      "Do not treat the source-file inventory below as a list of applied migrations.",
    );
  } else {
    lines.push(`Live ledger: ${code(metadata.migration_source)}. Only recorded migrations are reported.`, "");
    const applied = metadata.migrations.filter(m =>
      metadata.migration_source !== "public._prisma_migrations" || (m.finished_at && !m.rolled_back_at));
    const fields = [...new Set(applied.flatMap(m => Object.keys(m)))].sort();
    if (!applied.length) lines.push("No applied migration records in the live ledger.");
    else {
      lines.push(`| ${fields.map(cell).join(" | ")} |`, `| ${fields.map(() => "---").join(" | ")} |`);
      for (const migration of [...applied].sort((a, b) =>
        String(a.version ?? a.id ?? a.migration_name).localeCompare(String(b.version ?? b.id ?? b.migration_name)))) {
        lines.push(`| ${fields.map(f => cell(migration[f])).join(" | ")} |`);
      }
    }
  }
  return lines;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const [source, metaResult, sqlFiles, jobs] = await Promise.all([
    collectSource(root), readMetadata(), migrationFiles(),
    readAll<Job>("jobs", "id,status,started_at,finished_at"),
  ]);
  const tables = await mapLimit(metaResult.metadata.tables, 4, async table => {
    const response = await supabase.from(table.name).select("*", { count: "exact", head: true });
    if (response.error || response.count === null) {
      table.countError = safeError(response.error);
      warnings.push(`Live row count unavailable for public.${table.name} (${table.countError}).`);
    } else table.count = response.count;
    return table;
  });
  const appliedSection = ledgerLines(metaResult.metadata);
  const commits = git(["log", "-20", "--date=iso-strict", "--format=%h%x09%ad%x09%s"]).split("\n").filter(Boolean);
  const render = (compact: boolean): string[] => [
    `Generated: ${generatedAt}`, "# Platform state", "",
    "Regenerate with `npm run snapshot`. Database reads use the project's Supabase service-role client.",
    "Source: current repository files, live database metadata/counts/jobs, and Git. No memory or project notes are read.",
    "Counts are exact at each request time; this report is not a single transactional database snapshot.", "",
    "## Coverage and limitations", "",
    ...(warnings.length ? warnings.map(w => `- ${w}`) : ["- All requested data sources were read successfully."]),
    `- Schema source: ${metaResult.fullCatalog ? "live PostgreSQL catalog via service-role-only RPC" : "live service-role PostgREST OpenAPI"}.`,
    "- Migration files are an inventory only; applied status comes exclusively from a live migration ledger.",
    "- Environment classifications below are static evidence, not proof that a variable is configured at runtime.",
    "- Snapshot generation performs no database updates and sends no messages.", "",
    `## Public schema (${tables.length} ${metaResult.fullCatalog ? "tables" : "exposed relations"})`, "",
    ...(compact ? ["Columns are grouped by PostgreSQL type; all column names are retained.", ""] : []),
    ...tables.flatMap(table => tableLines(table, compact)), "",
    ...appliedSection, "",
    "### Migration SQL in source (application status NOT inferred)", "",
    ...(sqlFiles.length ? sqlFiles.map(file => `- ${code(file)}`) : ["No migration SQL files found."]), "",
    `## Express routes (${source.routes.length})`, "",
    "Paths include statically resolved router mounts. Dynamic/regex paths are labeled rather than omitted.",
    "| Method | Path | File:line |", "| --- | --- | --- |",
    ...source.routes.map(r => `| ${cell(r.method)} | ${code(r.path)} | ${code(`${r.file}:${r.line}`)} |`), "",
    `## Feature flags and environment variable names (${source.env.length})`, "",
    "Required = explicit source evidence (validation/throw or non-null assertion). Otherwise requiredness is not established.",
    "Feature flag = boolean comparison, flag-style name, or navigation mode. No values, defaults, or configuration state are included.",
    "| Name | Required by source | Feature flag | References |", "| --- | --- | --- | --- |",
    ...source.env.map(e => `| ${code(e.name)} | ${e.required ? "Yes" : "Not established"} | ${e.flag ? "Yes" : "No"} | ${e.locations.map(code).join(", ")} |`), "",
    `## Latest job runs (${jobs.length})`, "",
    "Each row is the latest record stored for that job; job history is not reconstructed from logs.",
    "| Job | Last started (UTC) | Finished (UTC) | Duration | Status |", "| --- | --- | --- | --- | --- |",
    ...jobs.sort((a, b) => a.id.localeCompare(b.id)).map(j =>
      `| ${code(j.id)} | ${cell(j.started_at)} | ${cell(j.finished_at)} | ${duration(j, generatedAt)} | ${cell(j.status)} |`), "",
    "## Last 20 Git commits", "", "| Commit | Time | Subject |", "| --- | --- | --- |",
    ...commits.map(commit => `| ${commit.split("\t").map(cell).join(" | ")} |`), "",
    `## TODO / FIXME in src (${source.todos.length})`, "",
    "| File:line | Source |", "| --- | --- |",
    ...source.todos.map(todo => `| ${code(`${todo.file}:${todo.line}`)} | ${cell(todo.text)} |`), "",
  ];
  let lines = render(false);
  if (lines.length > MAX_LINES) lines = render(true);
  if (lines.length > MAX_LINES) {
    // Preserve every entry rather than silently dropping routes/columns/TODOs.
    lines = lines.reduce<string[]>((out, line) => {
      if (line.startsWith("| ") && out.at(-1)?.startsWith("| ")) {
        out[out.length - 1] += `<br> ${line}`;
      } else out.push(line);
      return out;
    }, []);
  }
  if (lines.length > MAX_LINES) throw new Error("Report exceeds line budget; no incomplete file was written.");
  const temporary = `${output}.tmp`;
  await fs.writeFile(temporary, lines.join("\n"), { mode: 0o600 });
  await fs.rename(temporary, output);
  console.log(`Wrote PLATFORM_STATE.md (${lines.length} lines; ${tables.length} relations; ${source.routes.length} routes; ${source.todos.length} TODO/FIXME entries).`);
  if (warnings.length) console.warn(`Snapshot includes ${warnings.length} explicit coverage warnings; see Coverage and limitations.`);
  // Counts failing unexpectedly are a failed snapshot, not a silently complete one.
  if (tables.some(t => t.countError)) process.exitCode = 1;
  else if (!metaResult.fullCatalog || !metaResult.metadata.migration_source) {
    console.warn("Incomplete database coverage: catalog access or recorded migration history is unavailable; command exits nonzero.");
    process.exitCode = 2;
  }
}

main().catch(() => {
  // Do not log raw SDK/network errors, which could include credentials or URLs.
  console.error("Snapshot failed. Check database access, metadata permissions, source parsing, and Git availability. No complete snapshot was written.");
  process.exitCode = 1;
});
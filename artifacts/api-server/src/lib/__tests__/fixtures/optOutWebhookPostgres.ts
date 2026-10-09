import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { operatorPostgresFixture } from "./operatorPostgres";

/** Native SQL, socket-only disposable database; never uses a workspace DB URL. */
export function optOutWebhookPostgres() {
  const db = operatorPostgresFixture();
  const load = (name: string) => readFileSync(new URL(`../../../../migrations/${name}`, import.meta.url), "utf8");
  try {
    // Own the fixture schema; native migrations supply receipt/opt-out/alert
    // constraints and functions. Do not scrape seeds from another test.
    db.sql(`
      CREATE TABLE players(id uuid PRIMARY KEY,club_id uuid,name text,phone text,opted_out boolean DEFAULT false,sms_opt_in boolean DEFAULT true);
      CREATE TABLE conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,player_id uuid,triggered_by text,created_at timestamptz DEFAULT now());
      CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),player_id uuid,conversation_id uuid,body text,direction text,
        sent_by text,status text,twilio_message_sid text,sent_at timestamptz,error_code text,error_message text,
        approved_at timestamptz,delivery_status text,delivered_at timestamptz,dispatch_claimed_at timestamptz,dispatch_token uuid);
      CREATE TABLE retention_sequences(id uuid PRIMARY KEY,club_id uuid,player_id uuid,playbook_key text,sequence_status text,
        exit_reason text,step1_sent_at timestamptz,step2_sent_at timestamptz,step1_message_id uuid,step2_message_id uuid);
      CREATE TABLE retention_candidates(id uuid PRIMARY KEY,club_id uuid,player_id uuid,sequence_id uuid,playbook_key text,
        step smallint,message_id uuid,prelaunch_superseded_by uuid);
      CREATE TABLE attendances(player_id uuid,club_id uuid,event_id text,program_name text,attended_at timestamptz,booked_at timestamptz,coupon_code text);
    `);
    db.sql(`
      ALTER TABLE messages ADD COLUMN retention_delivery_kind text, ADD COLUMN approved_by text,
        ADD COLUMN approved_body text, ADD COLUMN simulated boolean DEFAULT false;
      ALTER TABLE retention_sequences ADD COLUMN exited_at timestamptz, ADD COLUMN booked_event_id text,
        ADD COLUMN updated_at timestamptz, ADD COLUMN step1_delivery_kind text;
      ALTER TABLE retention_candidates ADD COLUMN sequence_status text, ADD COLUMN exited_at timestamptz,
        ADD COLUMN exit_reason text, ADD COLUMN booked_event_id text, ADD COLUMN updated_at timestamptz,
        ADD COLUMN status text DEFAULT 'sent', ADD COLUMN context jsonb DEFAULT '{}';
      CREATE TABLE retention_capacity_reservations(sequence_id uuid);
    `);
    const transition = load("013_retention_ltp_sequence.sql")
      .match(/CREATE OR REPLACE FUNCTION public\.retention_sequence_transition\([\s\S]*?END \$\$;/)?.[0];
    assert.ok(transition);
    db.sql(transition);
    db.sql(load("021_sms_inbound_receipts.sql"));
    db.sql(load("022_retention_reports_and_optouts.sql"));
  } catch (error) {
    db.close();
    throw error;
  }
  const literal = (value: unknown): string => value == null ? "NULL"
    : `'${(typeof value === "object" ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'`;
  const identifier = (name: string) => {
    assert.match(name, /^[a-z_][a-z0-9_]*$/);
    return `"${name}"`;
  };
  const allowedTables = new Set(["players", "messages", "conversations", "sms_optout_events",
    "sms_optouts", "operator_alert_incidents", "operator_alert_events"]);
  const from = (table: string) => {
    assert.ok(allowedTables.has(table), `Unexpected fixture table: ${table}`);
    let action = "select", payload: Record<string, unknown> = {}, limit: number | undefined;
    let result: { data: unknown[]; error: null } | undefined;
    const predicates: string[] = [];
    const resolve = (single = false) => {
      if (!result) {
        const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
        let command = `SELECT * FROM public.${identifier(table)}${where}${limit ? ` LIMIT ${limit}` : ""}`;
        if (action === "update") {
          command = `UPDATE public.${identifier(table)} SET ${Object.entries(payload)
            .map(([key, value]) => `${identifier(key)}=${literal(value)}`).join(",")}${where} RETURNING *`;
        } else if (action === "upsert") {
          assert.equal(table, "sms_optout_events");
          command = `INSERT INTO public.${identifier(table)}(${Object.keys(payload).map(identifier).join(",")})
            VALUES(${Object.values(payload).map(literal).join(",")}) ON CONFLICT(message_id) DO NOTHING RETURNING *`;
        }
        result = { data: JSON.parse(db.sql(`WITH rows AS (${command})
          SELECT COALESCE(jsonb_agg(to_jsonb(rows)),'[]') FROM rows`)), error: null };
      }
      return { data: single ? result.data[0] ?? null : result.data, error: null };
    };
    const query: any = {
      select() { return query; },
      update(value: Record<string, unknown>) { action = "update"; payload = value; return query; },
      upsert(value: Record<string, unknown>) { action = "upsert"; payload = value; return query; },
      eq(key: string, value: unknown) { predicates.push(`${identifier(key)}=${literal(value)}`); return query; },
      is(key: string, value: unknown) { assert.equal(value, null); predicates.push(`${identifier(key)} IS NULL`); return query; },
      in(key: string, values: unknown[]) { predicates.push(`${identifier(key)} IN (${values.map(literal).join(",")})`); return query; },
      limit(value: number) { assert.ok(Number.isInteger(value) && value > 0); limit = value; return query; },
      maybeSingle() { return Promise.resolve(resolve(true)); },
      then(yes: any, no: any) { return Promise.resolve().then(() => resolve()).then(yes, no); },
    };
    return query;
  };
  const allowedRpcs = new Set(["capture_sms_inbound", "retention_sequence_transition", "operator_observe_alert"]);
  const rpc = async (name: string, args: Record<string, unknown>) => {
    assert.ok(allowedRpcs.has(name), `Unexpected fixture RPC: ${name}`);
    const params = Object.entries(args).map(([key, value]) => `${identifier(key)}=>${literal(value)}`).join(",");
    return { data: JSON.parse(db.sql(`SELECT public.${identifier(name)}(${params})`)), error: null };
  };
  return { ...db, from, rpc };
}

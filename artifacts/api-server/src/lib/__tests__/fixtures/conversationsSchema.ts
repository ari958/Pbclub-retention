/** Production REST schema checked 2026-10-09: all 13 columns, types,
 * advertised defaults/nullability and FK targets. Deliberately no created_at.
 * Catalog-only CHECK constraints/triggers are not exposed by REST metadata.
 */
export const conversationsTableSql = `
  CREATE TABLE conversations(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id uuid REFERENCES players(id),
    club_id uuid REFERENCES clubs(id),
    triggered_by text,
    programs_offered text[],
    outcome text,
    outcome_program text,
    attributed_booking boolean DEFAULT false,
    attributed_at timestamptz,
    attributed_program text,
    opened_at timestamptz DEFAULT now(),
    closed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;

import type { Candidate } from "./retentionApi";

/** A card may be approved only when it is not being edited (no open or unsaved textarea). */
export function canApprove(c: Candidate, editingIds: ReadonlySet<string>): boolean {
  return c.status === "drafted" && !!c.message && !editingIds.has(c.id);
}

/** Snapshot taken when the bulk dialog opens. Bodies are raw, unchanged. */
export function snapshotBulk(
  candidates: readonly Candidate[], selected: ReadonlySet<string>, playbookKey: string, editingIds: ReadonlySet<string>,
): { ids: string[]; bodies: Record<string, string>; excludedEditing: string[] } {
  const ids: string[] = []; const bodies: Record<string, string> = {};
  const excludedEditing: string[] = [];
  for (const c of candidates) {
    if (c.playbook_key !== playbookKey || c.status !== "drafted" || !selected.has(c.id) || !c.message) continue;
    if (editingIds.has(c.id)) { excludedEditing.push(c.id); continue; }
    ids.push(c.id); bodies[c.id] = c.message.body;
  }
  return { ids, bodies, excludedEditing };
}

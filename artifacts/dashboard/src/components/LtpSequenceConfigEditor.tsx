import { useEffect, useState } from "react";
import type { LtpSequenceConfig, Playbook } from "@/lib/retentionApi";
import {
  DEFAULT_LTP_SEQUENCE_CONFIG,
  ltpPhraseSlot,
  LTP_PHRASE_SLOT_KEYS,
  parsePhraseSlotEditor,
  type LtpPhraseSlotKey,
  updateLtpPhraseSlot,
  validateLtpSequenceConfig,
} from "@/lib/ltpPhraseSlots";

const SLOTS: Array<{ key: LtpPhraseSlotKey; label: string; purpose: string }> = [
  { key: "step1.opener", label: "Step 1 · opener", purpose: "Supported code-filled fact: {first}." },
  { key: "step1.thanks", label: "Step 1 · Learn to Play thank-you", purpose: "Use {ltp_date}; do not use only a weekday for past attendance." },
  { key: "step1.next_step", label: "Step 1 · with-program next step", purpose: "Supported code-filled facts: {program}, {when}." },
  { key: "step1.offer", label: "Step 1 · with-program offer", purpose: "Use {promo} for the verified code; code appends the next-step link." },
  { key: "step1.offer_no_program", label: "Step 1 · no-program offer", purpose: "Use {promo}; code appends the approved PB Club booking page." },
  { key: "step2.opener", label: "Step 2 · opener", purpose: "Supported code-filled fact: {first}." },
  { key: "step2.nudge", label: "Step 2 · nudge", purpose: "Do not include a code, discount, or percentage." },
  { key: "step2.next_step", label: "Step 2 · with-program next step", purpose: "Supported code-filled facts: {program}, {when}." },
  { key: "step2.no_program_cta", label: "Step 2 · no-program intro", purpose: "Code appends the approved PB Club booking page." },
];

function fieldStyle(): React.CSSProperties {
  return {
    width: "100%", boxSizing: "border-box", padding: 8, borderRadius: 5,
    border: "1px solid #30363d", background: "#1e2530", color: "#e6edf3",
    fontFamily: "var(--font-sans)", fontSize: 12, lineHeight: 1.55,
  };
}

export function LtpSequenceConfigEditor({
  playbook,
  schemaReady,
  busy,
  onSave,
}: {
  playbook: Playbook;
  schemaReady: boolean;
  busy: boolean;
  onSave: (key: string, config: LtpSequenceConfig) => Promise<boolean>;
}) {
  const serverConfig = playbook.ltp_sequence_config ?? DEFAULT_LTP_SEQUENCE_CONFIG;
  const serverValue = JSON.stringify(serverConfig);
  const [config, setConfig] = useState<LtpSequenceConfig>(serverConfig);
  const [lastLoadedValue, setLastLoadedValue] = useState(serverValue);
  const [needsReload, setNeedsReload] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (serverValue === lastLoadedValue) return;
    if (JSON.stringify(config) !== lastLoadedValue) {
      setNeedsReload(true);
      return;
    }
    setConfig(serverConfig);
    setLastLoadedValue(serverValue);
  }, [serverValue, config, lastLoadedValue, serverConfig]);

  const slotProblems = LTP_PHRASE_SLOT_KEYS.filter((key) => {
    const alternatives = ltpPhraseSlot(config, key);
    return alternatives.length === 0 || alternatives.length > 32 || alternatives.some((phrase) => !phrase.trim() || phrase.length > 240);
  });
  const valid = validateLtpSequenceConfig(config) && slotProblems.length === 0;
  const updateGap = (raw: string) => {
    const parsed = raw === "" ? 0 : Number(raw);
    setConfig((current) => ({ ...current, step2_gap_days: Number.isFinite(parsed) ? parsed : 0 }));
    setSaved(false);
    setError(null);
  };
  const updateSlot = (key: LtpPhraseSlotKey, raw: string) => {
    setConfig((current) => updateLtpPhraseSlot(current, key, parsePhraseSlotEditor(raw)));
    setSaved(false);
    setError(null);
  };
  const save = async () => {
    if (!valid || needsReload || !schemaReady || busy) return;
    setError(null);
    const success = await onSave(playbook.key, config);
    if (success) {
      const persistedValue = JSON.stringify(config);
      setLastLoadedValue(persistedValue);
      setSaved(true);
    } else {
      setError("The saved slot configuration was not confirmed. Your edits remain here.");
    }
  };

  return (
    <details data-testid={`details-ltp-config-${playbook.key}`} style={{ background: "#0f1117", border: "1px solid #30363d", borderRadius: 7, padding: "9px 12px" }}>
      <summary style={{ cursor: "pointer", color: "#e6edf3", fontSize: 12, fontWeight: 600 }}>
        Edit stored step 1 / step 2 phrases
        <span style={{ fontWeight: 400, color: "#8b949e" }}> · edits configuration only; existing drafts keep their saved text</span>
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#e6edf3", fontSize: 12 }}>
          <label htmlFor={`input-ltp-gap-${playbook.key}`} style={{ flex: 1 }}>Step 2 follow-up gap (days; 7–30)</label>
          <input
            id={`input-ltp-gap-${playbook.key}`}
            data-testid={`input-ltp-gap-${playbook.key}`}
            type="number" min={7} max={30} step={1}
            value={config.step2_gap_days || ""}
            disabled={!schemaReady || busy || needsReload}
            onChange={(event) => updateGap(event.target.value)}
            style={{ ...fieldStyle(), width: 96 }}
          />
        </div>
        <p data-testid={`hint-ltp-placeholders-${playbook.key}`} style={{ margin: 0, color: "#8b949e", fontSize: 11, lineHeight: 1.55 }}>
          One phrase per line. Code supplies facts; available placeholders are {"{first}"}, {"{ltp_date}"}, {"{program}"}, {"{when}"}, and {"{promo}"}.
          Slots are kept separate by step. Step 2 forbids any promotion.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
          {SLOTS.map(({ key, label, purpose }) => (
            <label key={key} data-testid={`field-ltp-slot-${key}`} style={{ display: "flex", flexDirection: "column", gap: 5, color: "#e6edf3", fontSize: 11 }}>
              <span style={{ fontWeight: 600 }}>{label}</span>
              <span style={{ color: "#8b949e" }}>{purpose}</span>
              <textarea
                data-testid={`input-ltp-slot-${key}`}
                value={ltpPhraseSlot(config, key).join("\n")}
                onChange={(event) => updateSlot(key, event.target.value)}
                disabled={!schemaReady || busy || needsReload}
                rows={Math.max(2, Math.min(5, ltpPhraseSlot(config, key).length))}
                style={{ ...fieldStyle(), resize: "vertical" }}
              />
              <span style={{ color: slotProblems.includes(key) ? "#ff6b6b" : "#8b949e" }}>
                {ltpPhraseSlot(config, key).length} phrase{ltpPhraseSlot(config, key).length === 1 ? "" : "s"}
                {slotProblems.includes(key) ? " · enter 1–32 nonempty phrases, each at most 240 characters" : ""}
              </span>
            </label>
          ))}
        </div>
        {needsReload && (
          <div role="alert" data-testid={`warning-ltp-config-changed-${playbook.key}`} style={{ color: "#d4813a", fontSize: 12 }}>
            The saved configuration changed elsewhere while these edits were open. Your text was preserved; reload before saving.
            <button
              type="button"
              data-testid={`button-ltp-config-reload-${playbook.key}`}
              onClick={() => { setConfig(serverConfig); setLastLoadedValue(serverValue); setNeedsReload(false); setSaved(false); setError(null); }}
              style={{ ...fieldStyle(), display: "inline-block", width: "auto", marginLeft: 9, cursor: "pointer" }}
            >Reload saved version</button>
          </div>
        )}
        {!schemaReady && <div role="alert" data-testid={`warning-ltp-config-schema-${playbook.key}`} style={{ color: "#d4813a", fontSize: 12 }}>Apply migration 013 before editing LTP sequence phrases.</div>}
          {config.step2_gap_days < 7 || config.step2_gap_days > 30 || !Number.isInteger(config.step2_gap_days)
          ? <div role="alert" data-testid={`warning-ltp-gap-${playbook.key}`} style={{ color: "#ff6b6b", fontSize: 12 }}>Step 2 gap must be an integer from 7 to 30 days.</div>
          : null}
        {error && <div role="alert" data-testid={`error-ltp-config-${playbook.key}`} style={{ color: "#ff6b6b", fontSize: 12 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12 }}>
          {saved && <span role="status" data-testid={`status-ltp-config-${playbook.key}`} style={{ color: "#2ea043", fontSize: 11 }}>Saved. Existing draft text is unchanged.</span>}
          <button
            type="button"
            data-testid={`button-save-ltp-config-${playbook.key}`}
            disabled={!schemaReady || busy || needsReload || !valid}
            onClick={save}
            style={{ borderRadius: 5, padding: "6px 12px", border: "1px solid rgba(232,168,56,0.4)", background: "#2b2418", color: "#e8a838", cursor: !schemaReady || busy || needsReload || !valid ? "not-allowed" : "pointer", opacity: !schemaReady || busy || needsReload || !valid ? 0.5 : 1 }}
          >
            {busy ? "Saving..." : "Save phrase configuration"}
          </button>
        </div>
      </div>
    </details>
  );
}
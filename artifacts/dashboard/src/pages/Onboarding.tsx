import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

// ─── Design tokens (matches existing dark theme) ──────────────────────────────

const D = {
  bg: "#0d1117",
  card: "#161b22",
  surface: "#1e2530",
  border: "#30363d",
  text: "#e6edf3",
  muted: "#8b949e",
  faint: "#6e7681",
  accent: "#E8A838",
  accentBg: "rgba(232,168,56,0.10)",
  accentBorder: "rgba(232,168,56,0.35)",
  green: "#2ea043",
  greenBg: "rgba(46,160,67,0.10)",
  greenBorder: "rgba(46,160,67,0.35)",
  red: "#cf222e",
  redBg: "rgba(207,34,46,0.08)",
  redText: "#ff6b6b",
} as const;

const TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver",
  "America/Los_Angeles", "America/Phoenix", "America/Anchorage",
  "Pacific/Honolulu", "America/Toronto", "America/Vancouver",
  "Europe/London", "Europe/Paris", "Australia/Sydney", "Pacific/Auckland",
];

// ─── Types ────────────────────────────────────────────────────────────────────

type Platform = "podplay" | "courtreserve";

interface CrCategory { id: string; name: string; }

interface FormState {
  name: string;
  timezone: string;
  scheduled_sync_time: string;
  platform: Platform | null;
  apiKey: string;
  orgId: string;
  crRatingCategoryId: string;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StepIndicator({ step, total }: { step: number; total: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 32 }}>
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: i < step ? 24 : 8,
            height: 8,
            borderRadius: 4,
            background: i < step ? D.accent : i === step ? D.accent : D.border,
            opacity: i === step ? 1 : i < step ? 0.7 : 0.35,
            transition: "all 0.25s ease",
          }} />
        </div>
      ))}
      <span style={{ fontSize: 11, color: D.faint, fontFamily: "var(--font-mono)", marginLeft: 4 }}>
        Step {step + 1} of {total}
      </span>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 500, color: D.muted, marginBottom: 6, letterSpacing: "0.02em" }}>
      {children}
    </div>
  );
}

function Input({
  value, onChange, placeholder, type = "text", disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      style={{
        width: "100%",
        padding: "9px 12px",
        background: D.surface,
        border: `1px solid ${D.border}`,
        borderRadius: 6,
        color: D.text,
        fontSize: 13,
        fontFamily: "var(--font-sans)",
        outline: "none",
        boxSizing: "border-box",
        opacity: disabled ? 0.5 : 1,
      }}
    />
  );
}

function Select({
  value, onChange, children, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      style={{
        width: "100%",
        padding: "9px 12px",
        background: D.surface,
        border: `1px solid ${D.border}`,
        borderRadius: 6,
        color: value ? D.text : D.muted,
        fontSize: 13,
        fontFamily: "var(--font-sans)",
        outline: "none",
        boxSizing: "border-box",
        appearance: "none",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </select>
  );
}

function Btn({
  onClick, disabled, variant = "primary", children,
}: {
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost";
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "10px 20px",
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 500,
        fontFamily: "var(--font-sans)",
        cursor: disabled ? "not-allowed" : "pointer",
        border: variant === "primary" ? "none" : `1px solid ${D.border}`,
        background: variant === "primary" ? (disabled ? D.border : D.accent) : "transparent",
        color: variant === "primary" ? (disabled ? D.muted : "#000") : D.muted,
        opacity: disabled ? 0.6 : 1,
        transition: "background 0.15s, color 0.15s",
      }}
    >
      {children}
    </button>
  );
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

// ─── Step 1: Club Setup ────────────────────────────────────────────────────────

function StepClubSetup({
  form,
  setForm,
  onNext,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  onNext: () => void;
}) {
  const canProceed = form.name.trim().length > 0 && form.timezone && form.scheduled_sync_time;

  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 600, color: D.text, marginBottom: 6 }}>
        Let's set up your club
      </div>
      <div style={{ fontSize: 13, color: D.muted, marginBottom: 28, lineHeight: 1.6 }}>
        This takes about 2 minutes. We'll connect your platform and import your member data.
      </div>

      <FieldGroup label="Club name">
        <Input
          value={form.name}
          onChange={(v) => setForm((f) => ({ ...f, name: v }))}
          placeholder="e.g. Riverside Pickleball Club"
        />
      </FieldGroup>

      <FieldGroup label="Timezone">
        <Select value={form.timezone} onChange={(v) => setForm((f) => ({ ...f, timezone: v }))}>
          <option value="">Select timezone…</option>
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>{tz.replace("_", " ")}</option>
          ))}
        </Select>
      </FieldGroup>

      <FieldGroup label="Nightly sync time">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Input
            type="time"
            value={form.scheduled_sync_time}
            onChange={(v) => setForm((f) => ({ ...f, scheduled_sync_time: v }))}
          />
          <span style={{ fontSize: 12, color: D.faint, whiteSpace: "nowrap" }}>
            in your timezone
          </span>
        </div>
      </FieldGroup>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
        <Btn onClick={onNext} disabled={!canProceed}>Continue</Btn>
      </div>
    </div>
  );
}

// ─── Step 2: Platform & Credentials ───────────────────────────────────────────

function StepPlatform({
  form,
  setForm,
  onBack,
  onNext,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  onBack: () => void;
  onNext: () => void;
}) {
  const [validating, setValidating] = useState(false);
  const [validated, setValidated] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [crCategories, setCrCategories] = useState<CrCategory[]>([]);

  const handlePlatformSelect = (p: Platform) => {
    setForm((f) => ({ ...f, platform: p, apiKey: "", orgId: "", crRatingCategoryId: "" }));
    setValidated(false);
    setValidationError(null);
    setCrCategories([]);
  };

  const handleValidate = async () => {
    if (!form.platform || !form.apiKey.trim()) return;
    setValidating(true);
    setValidationError(null);
    setValidated(false);

    try {
      const body: Record<string, string> = {
        platform: form.platform,
        apiKey: form.apiKey.trim(),
      };
      if (form.platform === "courtreserve") body.orgId = form.orgId.trim();

      const res = await fetch("/api/onboarding/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.valid) {
        setValidated(true);
        if (data.categories?.length) setCrCategories(data.categories);
      } else {
        setValidationError(data.error ?? "Could not connect. Check your credentials.");
      }
    } catch {
      setValidationError("Network error — please try again.");
    } finally {
      setValidating(false);
    }
  };

  const crReady =
    form.platform === "courtreserve"
      ? form.apiKey.trim() && form.orgId.trim()
      : false;
  const ppReady = form.platform === "podplay" ? form.apiKey.trim() : false;
  const canValidate = !validating && (ppReady || crReady);

  const canProceed =
    validated &&
    (form.platform !== "courtreserve" || !crCategories.length || form.crRatingCategoryId);

  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 600, color: D.text, marginBottom: 6 }}>
        Connect your platform
      </div>
      <div style={{ fontSize: 13, color: D.muted, marginBottom: 24, lineHeight: 1.6 }}>
        Choose the platform your club runs on and enter your API credentials.
      </div>

      {/* Platform cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 24 }}>
        {(["podplay", "courtreserve"] as Platform[]).map((p) => {
          const selected = form.platform === p;
          return (
            <button
              key={p}
              onClick={() => handlePlatformSelect(p)}
              style={{
                padding: "16px 14px",
                borderRadius: 8,
                border: `1.5px solid ${selected ? D.accent : D.border}`,
                background: selected ? D.accentBg : D.surface,
                cursor: "pointer",
                textAlign: "left",
                transition: "border 0.15s, background 0.15s",
              }}
            >
              <div style={{
                fontSize: 13,
                fontWeight: 600,
                color: selected ? D.accent : D.text,
                marginBottom: 4,
              }}>
                {p === "podplay" ? "PodPlay" : "CourtReserve"}
              </div>
              <div style={{ fontSize: 11, color: D.muted, lineHeight: 1.4 }}>
                {p === "podplay"
                  ? "pbclub.podplay.app"
                  : "api.courtreserve.com"}
              </div>
            </button>
          );
        })}
      </div>

      {/* Credential fields */}
      {form.platform && (
        <div
          style={{
            background: D.surface,
            border: `1px solid ${D.border}`,
            borderRadius: 8,
            padding: 16,
            marginBottom: 16,
          }}
        >
          <FieldGroup label="API key">
            <Input
              type="password"
              value={form.apiKey}
              onChange={(v) => { setForm((f) => ({ ...f, apiKey: v })); setValidated(false); setValidationError(null); }}
              placeholder="Paste your API key…"
              disabled={validating}
            />
          </FieldGroup>

          {form.platform === "courtreserve" && (
            <FieldGroup label="Organization ID">
              <Input
                value={form.orgId}
                onChange={(v) => { setForm((f) => ({ ...f, orgId: v })); setValidated(false); setValidationError(null); }}
                placeholder="e.g. 12345"
                disabled={validating}
              />
            </FieldGroup>
          )}

          {/* Validate button + status */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
            <button
              onClick={handleValidate}
              disabled={!canValidate}
              style={{
                padding: "8px 16px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                fontFamily: "var(--font-mono)",
                cursor: !canValidate ? "not-allowed" : "pointer",
                border: `1px solid ${validated ? D.greenBorder : D.border}`,
                background: validated ? D.greenBg : D.surface,
                color: validated ? D.green : D.muted,
                letterSpacing: "0.03em",
                opacity: !canValidate && !validated ? 0.5 : 1,
                transition: "all 0.2s",
              }}
            >
              {validating ? "Testing…" : validated ? "✓ Connected" : "Test connection"}
            </button>
            {validationError && (
              <span style={{ fontSize: 12, color: D.redText }}>{validationError}</span>
            )}
          </div>

          {/* CourtReserve: rating category */}
          {form.platform === "courtreserve" && validated && crCategories.length > 0 && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${D.border}` }}>
              <FieldGroup label="Skill rating category">
                <Select
                  value={form.crRatingCategoryId}
                  onChange={(v) => setForm((f) => ({ ...f, crRatingCategoryId: v }))}
                >
                  <option value="">Select which rating is pickleball skill…</option>
                  {crCategories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              </FieldGroup>
              <div style={{ fontSize: 11, color: D.faint, lineHeight: 1.5 }}>
                This is the CourtReserve custom rating category Pulse will use as the player's skill level.
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
        <Btn onClick={onBack} variant="ghost">Back</Btn>
        <Btn onClick={onNext} disabled={!canProceed}>Continue</Btn>
      </div>
    </div>
  );
}

// ─── Step 3: Launch ────────────────────────────────────────────────────────────

function StepLaunch({
  form,
  onBack,
}: {
  form: FormState;
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const [state, setState] = useState<"idle" | "saving" | "importing" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [importLogs, setImportLogs] = useState<string[]>([]);
  const [importStats, setImportStats] = useState<Record<string, number> | null>(null);

  const pollImport = async () => {
    let attempts = 0;
    const max = 120; // ~4 min at 2s intervals
    while (attempts < max) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch("/api/import/status");
        const data = await res.json();
        setImportLogs(data.recentLogs?.slice(-8) ?? []);
        if (data.stats) setImportStats(data.stats);
        if (data.status === "done" || data.status === "cancelled") {
          setState("done");
          return;
        }
        if (data.status === "error") {
          setError(data.error ?? "Import encountered an error.");
          setState("error");
          return;
        }
      } catch { /* keep polling */ }
      attempts++;
    }
    setState("done");
  };

  const handleLaunch = async () => {
    setState("saving");
    setError(null);

    try {
      const saveRes = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          timezone: form.timezone,
          scheduled_sync_time: form.scheduled_sync_time,
          platform: form.platform,
          apiKey: form.apiKey,
          orgId: form.orgId || undefined,
          crRatingCategoryId: form.crRatingCategoryId || undefined,
        }),
      });
      if (!saveRes.ok) {
        const d = await saveRes.json().catch(() => ({}));
        throw new Error(d.error ?? "Failed to save settings.");
      }

      setState("importing");
      await fetch("/api/import/players", { method: "POST" });
      pollImport();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unexpected error.");
      setState("error");
    }
  };

  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 600, color: D.text, marginBottom: 6 }}>
        {state === "done" ? "You're all set!" : "Review & launch"}
      </div>
      <div style={{ fontSize: 13, color: D.muted, marginBottom: 24, lineHeight: 1.6 }}>
        {state === "done"
          ? "Pulse has imported your member data and is ready to run."
          : "Confirm everything looks right, then start your initial member import."}
      </div>

      {/* Summary card */}
      {state !== "done" && (
        <div style={{
          background: D.surface,
          border: `1px solid ${D.border}`,
          borderRadius: 8,
          padding: 16,
          marginBottom: 20,
          display: "grid",
          gap: 10,
        }}>
          {[
            ["Club name", form.name],
            ["Platform", form.platform === "podplay" ? "PodPlay" : "CourtReserve"],
            ["Timezone", form.timezone],
            ["Nightly sync", form.scheduled_sync_time],
          ].map(([label, value]) => (
            <div key={label} style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 12, color: D.muted, minWidth: 110 }}>{label}</span>
              <span style={{ fontSize: 13, color: D.text, fontWeight: 500 }}>{value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Import progress */}
      {(state === "importing" || state === "done") && (
        <div style={{
          background: D.card,
          border: `1px solid ${state === "done" ? D.greenBorder : D.border}`,
          borderRadius: 8,
          padding: 14,
          marginBottom: 20,
        }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: state === "done" ? D.green : D.muted, marginBottom: 8, fontFamily: "var(--font-mono)" }}>
            {state === "done" ? "✓ Import complete" : "Importing members…"}
          </div>

          {importStats && (
            <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
              {Object.entries(importStats).map(([k, v]) => (
                <div key={k} style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: D.muted }}>
                  <span style={{ color: D.accent }}>{v}</span>{" "}
                  {k.replace(/_/g, " ")}
                </div>
              ))}
            </div>
          )}

          {importLogs.length > 0 && (
            <div style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: D.faint,
              lineHeight: 1.6,
              maxHeight: 120,
              overflowY: "auto",
            }}>
              {importLogs.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}

          {state === "importing" && (
            <div style={{ marginTop: 8, height: 3, borderRadius: 2, background: D.border, overflow: "hidden" }}>
              <div style={{
                height: "100%",
                borderRadius: 2,
                background: D.accent,
                width: "40%",
                animation: "slide 1.5s linear infinite",
              }} />
            </div>
          )}
        </div>
      )}

      {error && (
        <div style={{
          background: D.redBg,
          border: `1px solid rgba(207,34,46,0.25)`,
          borderRadius: 6,
          padding: "10px 12px",
          fontSize: 12,
          color: D.redText,
          marginBottom: 16,
        }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between" }}>
        {state === "idle" || state === "error" ? (
          <>
            <Btn onClick={onBack} variant="ghost" disabled={state === "saving"}>Back</Btn>
            <Btn onClick={handleLaunch} disabled={state === "saving"}>
              {state === "error" ? "Try again" : "Launch import"}
            </Btn>
          </>
        ) : state === "done" ? (
          <Btn onClick={() => navigate("/")}>Go to dashboard</Btn>
        ) : (
          <span style={{ fontSize: 12, color: D.muted, alignSelf: "center" }}>
            {state === "saving" ? "Saving settings…" : "Importing your members — this takes a minute…"}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Main Onboarding page ──────────────────────────────────────────────────────

export default function Onboarding() {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>({
    name: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
    scheduled_sync_time: "02:00",
    platform: null,
    apiKey: "",
    orgId: "",
    crRatingCategoryId: "",
  });

  const TOTAL_STEPS = 3;

  return (
    <div style={{
      minHeight: "100vh",
      background: D.bg,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "32px 16px",
      fontFamily: "var(--font-sans)",
    }}>
      <style>{`
        @keyframes slide {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
      `}</style>

      {/* Logo */}
      <div style={{ marginBottom: 32, display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: D.accent, animation: "pulseBreath 2.4s ease-in-out infinite",
          flexShrink: 0,
        }} />
        <span style={{
          fontSize: 24, fontWeight: 700, color: D.accent,
          letterSpacing: "-0.02em", lineHeight: 1,
        }}>
          Pulse
        </span>
      </div>

      {/* Card */}
      <div style={{
        width: "100%",
        maxWidth: 520,
        background: D.card,
        border: `1px solid ${D.border}`,
        borderRadius: 12,
        padding: "32px 32px 28px",
        boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
      }}>
        <StepIndicator step={step} total={TOTAL_STEPS} />

        {step === 0 && (
          <StepClubSetup
            form={form}
            setForm={setForm}
            onNext={() => setStep(1)}
          />
        )}
        {step === 1 && (
          <StepPlatform
            form={form}
            setForm={setForm}
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && (
          <StepLaunch
            form={form}
            onBack={() => setStep(1)}
          />
        )}
      </div>

      <div style={{ marginTop: 24, fontSize: 11, color: D.faint }}>
        Pulse · Pickleball retention platform
      </div>
    </div>
  );
}

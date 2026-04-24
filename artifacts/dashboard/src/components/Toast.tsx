import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";

type ToastVariant = "success" | "error" | "info";

interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  addToast: (message: string, variant: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const addToast = useCallback((message: string, variant: ToastVariant) => {
    const id = String(++idRef.current);
    setToasts((prev) => [...prev, { id, message, variant }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <ToastContainer toasts={toasts} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be inside ToastProvider");
  return {
    success: (message: string) => ctx.addToast(message, "success"),
    error: (message: string) => ctx.addToast(message, "error"),
    info: (message: string) => ctx.addToast(message, "info"),
  };
}

const VSTYLES: Record<ToastVariant, { bg: string; border: string; dot: string }> = {
  success: {
    bg: "rgba(15,40,20,0.97)",
    border: "rgba(46,160,67,0.35)",
    dot: "var(--state-active)",
  },
  error: {
    bg: "rgba(40,10,12,0.97)",
    border: "rgba(207,34,46,0.35)",
    dot: "var(--state-dormant)",
  },
  info: {
    bg: "rgba(40,28,5,0.97)",
    border: "rgba(232,168,56,0.35)",
    dot: "var(--accent)",
  },
};

function ToastContainer({ toasts }: { toasts: ToastItem[] }) {
  if (toasts.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => {
        const s = VSTYLES[t.variant];
        return (
          <div
            key={t.id}
            style={{
              background: s.bg,
              border: `1px solid ${s.border}`,
              borderRadius: 6,
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              gap: 9,
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              color: "#e6edf3",
              minWidth: 220,
              maxWidth: 360,
              backdropFilter: "blur(10px)",
              boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: s.dot,
                flexShrink: 0,
                boxShadow: `0 0 6px ${s.dot}`,
              }}
            />
            {t.message}
          </div>
        );
      })}
    </div>
  );
}

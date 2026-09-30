export type NavMode = "retention" | "programming" | "pulse" | "all";
export const NAV_MODE: NavMode =
  (import.meta.env.VITE_NAV_MODE as NavMode | undefined) ?? "retention";
export const RETENTION = NAV_MODE === "retention";

export type ApprovalVariantPresentation = {
  kind: "with_program" | "no_program" | "pending";
  label: string;
};

export function approvalVariantPresentation(variant: unknown): ApprovalVariantPresentation {
  if (variant === "with_program") {
    return { kind: "with_program", label: "with_program / Program suggestion" };
  }
  if (variant === "no_program") {
    return { kind: "no_program", label: "no_program / No program suggestion" };
  }
  return { kind: "pending", label: "Pending variant" };
}
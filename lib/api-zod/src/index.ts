export * from "./generated/api";
export * from "./generated/types";
// Orval names both path-parameter validators and query-parameter interfaces
// OperationParams. Resolve the dual wildcard exports explicitly, keeping both.
export {
  ApproveRetentionDraftParams,
  ApproveRetentionPlaybookDraftsParams,
  EditRetentionDraftParams,
  RegenerateRetentionDraftParams,
  SkipRetentionDraftParams,
} from "./generated/api";
export type {
  ApproveRetentionDraftParams as ApproveRetentionDraftQuery,
  ApproveRetentionPlaybookDraftsParams as ApproveRetentionPlaybookDraftsQuery,
  EditRetentionDraftParams as EditRetentionDraftQuery,
  RegenerateRetentionDraftParams as RegenerateRetentionDraftQuery,
  SkipRetentionDraftParams as SkipRetentionDraftQuery,
} from "./generated/types";

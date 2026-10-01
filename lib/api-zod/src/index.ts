export * from "./generated/api";
export * from "./generated/types";
// Orval names both path-parameter validators and query-parameter interfaces
// OperationParams. Resolve the dual wildcard exports explicitly, keeping both.
export {
  ApproveRetentionDraftParams,
  ApproveRetentionPlaybookDraftsParams,
  EditRetentionDraftParams,
  RegenerateRetentionDraftParams,
  ReshuffleRetentionLtpDraftParams,
  RetryRetentionContextParams,
  SkipRetentionDraftParams,
  UpdateRetentionLtpPhraseConfigParams,
} from "./generated/api";
export type {
  ApproveRetentionDraftParams as ApproveRetentionDraftQuery,
  ApproveRetentionPlaybookDraftsParams as ApproveRetentionPlaybookDraftsQuery,
  EditRetentionDraftParams as EditRetentionDraftQuery,
  RegenerateRetentionDraftParams as RegenerateRetentionDraftQuery,
  ReshuffleRetentionLtpDraftParams as ReshuffleRetentionLtpDraftQuery,
  RetryRetentionContextParams as RetryRetentionContextQuery,
  SkipRetentionDraftParams as SkipRetentionDraftQuery,
  UpdateRetentionLtpPhraseConfigParams as UpdateRetentionLtpPhraseConfigQuery,
} from "./generated/types";

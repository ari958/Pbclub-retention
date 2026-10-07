export interface SchemaReadinessReport {
  configuration: string; connectivity: string; schema: string;
  errors: string[]; target: string; coverage: string; limitations: string;
}
export function checkSchemaReadiness(options?: {
  env?: Record<string, string | undefined>; fetchImpl?: typeof fetch;
  requestTimeoutMs?: number; totalTimeoutMs?: number; maxMetadataBytes?: number;
}): Promise<SchemaReadinessReport>;
export function databaseConfigurationErrors(env: Record<string, string | undefined>): string[];
export const schemaRequirements: readonly { table: string; columns: string[]; methods: string[] }[];
export const leaseRequirements: readonly { name: string; args: string[] }[];

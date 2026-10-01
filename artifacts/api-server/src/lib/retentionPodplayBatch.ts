export type RetentionPodplayEndpointCategory = "listing" | "signups" | "trigger" | "coupons";

export interface RetentionPodplayFetchInit extends RequestInit {
  requestTimeoutMs?: number;
}

export type RetentionPodplayFetch = (
  input: string | URL | Request,
  init?: RetentionPodplayFetchInit,
) => Promise<Response>;

export interface RetentionPodplayRetryDiagnostic {
  path: string;
  attempt: number;
  retry_number: number;
  wait_ms: number;
  status: 429;
}

export interface RetentionPodplayStatusDiagnostic {
  path: string;
  category: RetentionPodplayEndpointCategory;
  attempt: number;
  status: number | "network_error";
}

export interface RetentionPodplayTelemetry {
  total_calls: number;
  listing_calls: number;
  signup_calls: number;
  trigger_calls: number;
  coupon_calls: number;
  rate_limit_count: number;
  retries: RetentionPodplayRetryDiagnostic[];
  statuses: RetentionPodplayStatusDiagnostic[];
}

export interface RetentionPodplayBatchOptions {
  fetchImpl?: RetentionPodplayFetch;
  sleep?: (milliseconds: number) => Promise<void>;
  minimumSpacingMs?: number;
  timeoutSignalFactory?: (timeoutMs: number) => AbortSignal;
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function requestPath(input: string | URL | Request): string {
  try {
    return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
  } catch {
    return String(input).split("?")[0];
  }
}

function classifyPodplayEndpoint(input: string | URL | Request): RetentionPodplayEndpointCategory {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    "https://podplay.invalid",
  );
  if (url.pathname.endsWith("/coupons")) return "coupons";
  if (/\/events\/[^/]+\/signups$/.test(url.pathname)) return "signups";
  if (/\/events\/[^/]+$/.test(url.pathname)) return "trigger";
  return "listing";
}

function retryAfterMilliseconds(value: string | null, now: number): number | null {
  if (!value?.trim()) return null;
  const header = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(header)) return Math.max(0, Number(header) * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * Shared request queue for retention's PodPlay reads. The wrapper intentionally
 * records only endpoint paths/statuses; request headers and credentials never
 * enter telemetry.
 */
export class RetentionPodplayBatchClient {
  readonly telemetry: RetentionPodplayTelemetry = {
    total_calls: 0,
    listing_calls: 0,
    signup_calls: 0,
    trigger_calls: 0,
    coupon_calls: 0,
    rate_limit_count: 0,
    retries: [],
    statuses: [],
  };

  private queue: Promise<void> = Promise.resolve();
  private lastRequestCompletedAt: number | null = null;
  private readonly fetchImpl: RetentionPodplayFetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly minimumSpacingMs: number;
  private readonly timeoutSignalFactory: (timeoutMs: number) => AbortSignal;

  constructor(options: RetentionPodplayBatchOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.minimumSpacingMs = options.minimumSpacingMs ?? 400;
    this.timeoutSignalFactory = options.timeoutSignalFactory ?? ((timeoutMs) => AbortSignal.timeout(timeoutMs));
  }

  /** Fetch-client override shape usable by coupon validation helpers. */
  fetch: RetentionPodplayFetch = (input, init) => {
    const result = this.queue.then(() => this.fetchWithRetry(input, init));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  };

  private async startSpacedRequest(): Promise<void> {
    if (this.lastRequestCompletedAt !== null) {
      const elapsed = Date.now() - this.lastRequestCompletedAt;
      const remaining = this.minimumSpacingMs - elapsed;
      if (remaining > 0) await this.sleep(remaining);
    }
  }

  private async fetchWithRetry(input: string | URL | Request, init?: RetentionPodplayFetchInit): Promise<Response> {
    const category = classifyPodplayEndpoint(input);
    const path = requestPath(input);
    const {
      requestTimeoutMs = 15_000,
      signal: callerSignal,
      ...requestInit
    } = init ?? {};
    const originalSignal = callerSignal ?? (input instanceof Request ? input.signal : undefined);
    const counter = {
      listing: "listing_calls",
      signups: "signup_calls",
      trigger: "trigger_calls",
      coupons: "coupon_calls",
    }[category] as "listing_calls" | "signup_calls" | "trigger_calls" | "coupon_calls";

    for (let attempt = 1; attempt <= 4; attempt++) {
      await this.startSpacedRequest();
      let response: Response;
      try {
        const timeoutSignal = this.timeoutSignalFactory(requestTimeoutMs);
        const signal = originalSignal
          ? AbortSignal.any([originalSignal, timeoutSignal])
          : timeoutSignal;
        this.telemetry.total_calls++;
        this.telemetry[counter]++;
        response = await this.fetchImpl(input, { ...requestInit, signal });
      } catch (error) {
        this.lastRequestCompletedAt = Date.now();
        this.telemetry.statuses.push({ path, category, attempt, status: "network_error" });
        throw error;
      }
      this.lastRequestCompletedAt = Date.now();
      this.telemetry.statuses.push({ path, category, attempt, status: response.status });

      if (response.status !== 429) return response;
      this.telemetry.rate_limit_count++;
      if (attempt === 4) return response;

      const retryNumber = attempt;
      const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"), Date.now());
      const waitMs = retryAfter ?? 1000 * (2 ** (retryNumber - 1));
      this.telemetry.retries.push({
        path,
        attempt,
        retry_number: retryNumber,
        wait_ms: waitMs,
        status: 429,
      });
      if (waitMs > 0) await this.sleep(waitMs);
    }

    throw new Error("PodPlay request retry loop exited unexpectedly");
  }
}

/** Legacy callers still receive process-wide serialization and rate limiting. */
export const defaultRetentionPodplayBatchClient = new RetentionPodplayBatchClient();
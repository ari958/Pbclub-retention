export function createAttendanceCouponResolver(
  podplayBase: string,
  apiKey: string,
  options?: {
    fetchImpl?: (url: string, options?: RequestInit) => Promise<Response>;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): (signup: { couponCode?: unknown; coupon?: { id?: string; code?: string } | null; order?: { id?: string } | null }) => Promise<string | null>;

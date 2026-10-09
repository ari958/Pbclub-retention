export function createAttendanceCouponResolver(
  podplayBase: string,
  apiKey: string,
  options?: {
    fetchImpl?: (url: string, options?: RequestInit) => Promise<Response>;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): ((signup: { couponCode?: unknown; coupon?: { id?: string; code?: string } | null; order?: { id?: string } | null }) => Promise<string | null>) & { getStats(): { orderCalls: number; couponCalls: number } };

export function resolveInsertedAttendanceCoupon(resolve: (signup: any) => Promise<string | null>, signup: any,
  playerId: string, existing: Map<string, string | null>): Promise<string | null>;

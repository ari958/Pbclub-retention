import { supabase } from "./supabaseClient";
import { defaultRetentionPodplayBatchClient, type RetentionPodplayFetch } from "./retentionPodplayBatch";
import { findSequenceFlowByPromoCode } from "./retentionFlows";

export interface RetentionCouponValidation {
  valid: boolean;
  warning: string | null;
  checked_at: string;
  ends_at?: string | null;
  lookup_failed?: boolean;
}

const PROGRAM_BOOKING_TYPES = new Set(["EVENT_CLASS", "EVENT_EVENT"]);

/** A flow's verified coupon must be exactly its advertised percentage off generic program bookings. */
function getBenefitWarning(coupon: any, code: string, percent: number | null): string | null {
  if (coupon.discountType !== "PERCENT_OFF") {
    return `Coupon ${code} does not have a verified percentage discount`;
  }
  if (percent === null || typeof coupon.value !== "number" || coupon.value !== percent) {
    return `Coupon ${code} is not verified as a ${percent ?? "?"}% discount`;
  }

  const eligibleTypes = coupon.eligibleTypes;
  if (
    typeof coupon.eligibleType !== "string"
    || !PROGRAM_BOOKING_TYPES.has(coupon.eligibleType)
    || !Array.isArray(eligibleTypes)
    || eligibleTypes.length === 0
    || eligibleTypes.some((type: unknown) => typeof type !== "string" || !PROGRAM_BOOKING_TYPES.has(type))
    || !eligibleTypes.includes(coupon.eligibleType)
    || !Array.isArray(coupon.eligibleEventIds)
    || coupon.eligibleEventIds.length > 0
  ) {
    return `Coupon ${code} applicability is not verified for generic program bookings`;
  }

  return null;
}

/** Read-only, fail-closed check against the club's live PodPlay coupons. */
export async function validateRetentionCoupon(
  clubId: string,
  code: string,
  fetchClient: RetentionPodplayFetch = defaultRetentionPodplayBatchClient.fetch,
): Promise<RetentionCouponValidation> {
  const checked_at = new Date().toISOString();
  try {
    const { data: club, error } = await supabase
      .from("clubs")
      .select("platform_api_key, platform_subdomain, timezone")
      .eq("id", clubId)
      .maybeSingle();
    if (error || !club?.platform_subdomain) throw new Error("Club PodPlay configuration unavailable");
    const apiKey = club.platform_api_key ?? process.env.PODPLAY_API_KEY;
    if (!apiKey) throw new Error("PodPlay API credentials unavailable");
    const base = `https://${club.platform_subdomain}.podplay.app`;
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: club.timezone ?? "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    let page = 1;
    while (page <= 100) {
      const response = await fetchClient(`${base}/apis/v2/coupons?page=${page}&ipp=100`, {
        headers: { "x-api-key": apiKey },
        requestTimeoutMs: 12_000,
      });
      if (!response.ok) throw new Error(`PodPlay /coupons returned ${response.status}`);
      const payload = await response.json() as any;
      const coupons = Array.isArray(payload) ? payload : payload.items ?? [];
      const coupon = coupons.find((item: any) => item.code === code);
      if (coupon) {
        const ends_at = coupon.endDate ?? coupon.end_date ?? null;
        const starts = coupon.startDate ?? coupon.start_date;
        const startDate = typeof starts === "string" && /^\d{4}-\d{2}-\d{2}/.test(starts) ? starts.slice(0, 10) : null;
        const endDate = typeof ends_at === "string" && /^\d{4}-\d{2}-\d{2}/.test(ends_at) ? ends_at.slice(0, 10) : null;
        const dateValid = coupon.active === true
          && (!starts || !!startDate)
          && (!ends_at || !!endDate)
          && (!endDate || endDate >= today)
          && (!startDate || startDate <= today);
        const verifiedFlow = findSequenceFlowByPromoCode(code);
        const benefitWarning = verifiedFlow ? getBenefitWarning(coupon, code, verifiedFlow.sequence.rules.verifiedPercent) : null;
        const warnings = [
          ...(!dateValid ? [`Coupon ${code} is inactive or outside its valid date range`] : []),
          ...(benefitWarning ? [benefitWarning] : []),
        ];
        return {
          valid: dateValid && !benefitWarning,
          warning: warnings.length ? warnings.join("; ") : null,
          checked_at,
          ends_at,
        };
      }
      const totalPages = Number(payload.totalPages ?? payload.pages ?? 0);
      const hasMore = payload.hasMore === true || (totalPages > page)
        || (payload.total && page * 100 < Number(payload.total));
      if (!hasMore && coupons.length < 100) break;
      page++;
    }
    return { valid: false, warning: `Coupon ${code} was not found in PodPlay`, checked_at };
  } catch (error: any) {
    return { valid: false, warning: `Could not verify coupon ${code}: ${error.message}`, checked_at, lookup_failed: true };
  }
}
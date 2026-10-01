import { supabase } from "./supabaseClient";

export interface RetentionCouponValidation {
  valid: boolean;
  warning: string | null;
  checked_at: string;
  ends_at?: string | null;
}

const LTP_PROGRAM_BOOKING_TYPES = new Set(["EVENT_CLASS", "EVENT_EVENT"]);

function getLtpBenefitWarning(coupon: any): string | null {
  if (coupon.discountType !== "PERCENT_OFF") {
    return "Coupon LTPNEXT25 does not have a verified percentage discount";
  }
  if (typeof coupon.value !== "number" || coupon.value !== 25) {
    return "Coupon LTPNEXT25 is not verified as a 25% discount";
  }

  const eligibleTypes = coupon.eligibleTypes;
  if (
    typeof coupon.eligibleType !== "string"
    || !LTP_PROGRAM_BOOKING_TYPES.has(coupon.eligibleType)
    || !Array.isArray(eligibleTypes)
    || eligibleTypes.length === 0
    || eligibleTypes.some((type: unknown) => typeof type !== "string" || !LTP_PROGRAM_BOOKING_TYPES.has(type))
    || !eligibleTypes.includes(coupon.eligibleType)
    || !Array.isArray(coupon.eligibleEventIds)
    || coupon.eligibleEventIds.length > 0
  ) {
    return "Coupon LTPNEXT25 applicability is not verified for generic program bookings";
  }

  return null;
}

/** Read-only, fail-closed check against the club's live PodPlay coupons. */
export async function validateRetentionCoupon(
  clubId: string,
  code: string,
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
      const response = await fetch(`${base}/apis/v2/coupons?page=${page}&ipp=100`, {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(12_000),
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
        const benefitWarning = code === "LTPNEXT25" ? getLtpBenefitWarning(coupon) : null;
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
    return { valid: false, warning: `Could not verify coupon ${code}: ${error.message}`, checked_at };
  }
}
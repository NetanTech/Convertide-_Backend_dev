import { supabaseAdmin } from "../config/supabase";
import { isPaystackConfigured } from "./paystack";
import { isStripeConfigured } from "./stripe";
import { ensureBillingAccount } from "./billing";

export type BillingProvider = "stripe" | "paystack";

function forcedProvider(): BillingProvider | null {
  const forced = process.env.BILLING_PROVIDER?.trim().toLowerCase();
  if (forced === "stripe") return isStripeConfigured() ? "stripe" : null;
  if (forced === "paystack") return isPaystackConfigured() ? "paystack" : null;
  // "auto" / empty / dual → null (resolve per user)
  return null;
}

export function listConfiguredProviders(): BillingProvider[] {
  const out: BillingProvider[] = [];
  if (isStripeConfigured()) out.push("stripe");
  if (isPaystackConfigured()) out.push("paystack");
  return out;
}

/** Country hint: billing address, then phone ISO from auth metadata. */
export function isNigeriaCountry(country: string | null | undefined): boolean {
  if (!country) return false;
  const c = country.trim().toUpperCase();
  return c === "NG" || c === "NGA" || c === "NIGERIA";
}

/** What the caller's browser implies about their location. */
export type ClientRegionHint = {
  /** IANA zone, e.g. "Africa/Lagos". */
  timeZone?: string | null;
  /** Raw Accept-Language value, e.g. "en-NG,en;q=0.9". */
  acceptLanguage?: string | null;
};

// Nigerian users very often run an en-US locale, so the zone is the stronger signal.
// tzdata links several West African zones to Africa/Lagos; Paystack covers those too.
const TIMEZONE_COUNTRY: Record<string, string> = {
  "Africa/Lagos": "NG",
  "Africa/Accra": "GH",
  "Africa/Nairobi": "KE",
  "Africa/Johannesburg": "ZA",
};

/** Best-effort country from a browser hint. Zone first, then the locale's region. */
export function countryFromClientHint(hint?: ClientRegionHint | null): string | null {
  if (!hint) return null;

  const zone = hint.timeZone?.trim();
  if (zone && TIMEZONE_COUNTRY[zone]) return TIMEZONE_COUNTRY[zone];

  const primary = hint.acceptLanguage?.split(",")[0]?.trim();
  if (primary) {
    try {
      const region = new Intl.Locale(primary).region;
      if (region) return region;
    } catch {
      // Malformed header — fall through.
    }
  }

  return null;
}

/**
 * Country for provider routing, most trustworthy source first: the billing address they
 * typed, then their phone's country, then what the browser implies.
 */
export async function resolveUserCountryHint(
  userId: string,
  userMetadata?: Record<string, unknown> | null,
  clientHint?: ClientRegionHint | null
): Promise<string | null> {
  try {
    const account = await ensureBillingAccount(userId);
    if (account.billing_country) return account.billing_country;
  } catch {
    // ignore
  }
  const phoneIso = userMetadata?.phone_country_iso;
  if (typeof phoneIso === "string" && phoneIso.trim()) return phoneIso.trim();
  return countryFromClientHint(clientHint);
}

/**
 * Checkout routing:
 * - BILLING_PROVIDER=stripe|paystack forces one processor
 * - Otherwise: Nigeria → Paystack by default (Stripe also allowed if preferred)
 * - Elsewhere → Stripe (Paystack only if explicitly preferred and configured)
 */
export async function resolveBillingProvider(opts?: {
  userId?: string;
  preferred?: BillingProvider | null;
  userMetadata?: Record<string, unknown> | null;
  clientHint?: ClientRegionHint | null;
}): Promise<BillingProvider | null> {
  const forced = forcedProvider();
  if (forced) return forced;

  const configured = listConfiguredProviders();
  if (configured.length === 0) return null;
  if (configured.length === 1) return configured[0];

  const preferred = opts?.preferred;
  if (preferred && configured.includes(preferred)) return preferred;

  let country: string | null = null;
  if (opts?.userId) {
    country = await resolveUserCountryHint(opts.userId, opts.userMetadata, opts.clientHint);
  } else {
    const phoneIso = opts?.userMetadata?.phone_country_iso;
    country =
      typeof phoneIso === "string" && phoneIso.trim()
        ? phoneIso
        : countryFromClientHint(opts?.clientHint);
  }

  if (isNigeriaCountry(country)) {
    if (isPaystackConfigured()) return "paystack";
    if (isStripeConfigured()) return "stripe";
    return null;
  }

  if (isStripeConfigured()) return "stripe";
  if (isPaystackConfigured()) return "paystack";
  return null;
}

/** Portal / manage: prefer the provider the user already subscribed with. */
export async function resolveBillingProviderForPortal(userId: string): Promise<BillingProvider | null> {
  const forced = forcedProvider();
  if (forced) return forced;

  const { data } = await supabaseAdmin
    .from("billing_accounts")
    .select("stripe_subscription_id, paystack_subscription_code")
    .eq("user_id", userId)
    .maybeSingle();

  const row = data as {
    stripe_subscription_id?: string | null;
    paystack_subscription_code?: string | null;
  } | null;

  if (row?.stripe_subscription_id && isStripeConfigured()) return "stripe";
  if (row?.paystack_subscription_code && isPaystackConfigured()) return "paystack";

  return resolveBillingProvider({ userId });
}

/** Providers a user may choose at checkout (Nigeria can use both when both configured). */
export async function checkoutProviderChoices(
  userId: string,
  userMetadata?: Record<string, unknown> | null,
  clientHint?: ClientRegionHint | null
): Promise<BillingProvider[]> {
  const forced = forcedProvider();
  if (forced) return [forced];

  const configured = listConfiguredProviders();
  if (configured.length <= 1) return configured;

  const country = await resolveUserCountryHint(userId, userMetadata, clientHint);
  if (isNigeriaCountry(country)) return configured;
  // International: Stripe only (Paystack is NGN-focused)
  return isStripeConfigured() ? ["stripe"] : configured;
}

export function billingNotConfiguredMessage() {
  return "Billing is not configured yet. Add STRIPE_SECRET_KEY (and price IDs) or PAYSTACK_SECRET_KEY to the backend .env.";
}

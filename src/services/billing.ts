import { supabaseAdmin } from "../config/supabase";

export type PlanTierId = "free" | "pro" | "enterprise";

/** Subscription billing interval. Yearly charges 10 months (2 months free). */
export type BillingInterval = "monthly" | "yearly";

/** Months charged on an annual subscription (12 − 2 free). */
export const ANNUAL_MONTHS_CHARGED = 10;

export type BillingAccountRow = {
  user_id: string;
  plan_id: PlanTierId;
  plan_name: string;
  plan_price: string;
  plan_cycle: string;
  billing_cycle: string;
  renews_on: string | null;
  credits_used: number;
  credits_total: number;
  seats_used: number;
  seats_limit: number;
  projects: string;
  api_priority: string;
  payment_brand: string | null;
  payment_last4: string | null;
  payment_expiry: string | null;
  billing_company: string | null;
  billing_line1: string | null;
  billing_line2: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_postal_code: string | null;
  billing_country: string | null;
  /** Renewal is off; the plan stays active until `renews_on` passes. */
  cancel_at_period_end: boolean;
  /** Tier this account moves to once `pending_plan_starts_on` arrives. */
  pending_plan_id: PlanTierId | null;
  pending_plan_starts_on: string | null;
};

export type PaymentMethodRow = {
  id: string;
  user_id: string;
  brand: "visa" | "mastercard";
  last4: string;
  expiry: string;
  is_primary: boolean;
  created_at: string;
};

// Static tier catalog. Prices/features live here rather than in the DB since
// they're product config, not per-user data. Paid tiers: yearly = 10× monthly (2 months free).
const TIER_CATALOG: Record<
  PlanTierId,
  {
    name: string;
    description: string;
    price: string;
    cycle: string | null;
    /** USD monthly list price; null for Free. */
    monthlyUsd: number | null;
    features: string[];
    creditsTotal: number | null;
    seatsLimit: number | null;
    projects: string;
    apiPriority: string;
  }
> = {
  // Feature strings must stay aligned with frontend `PLAN_FEATURES` in src/lib/pricing.ts.
  free: {
    name: "Free",
    description: "Generate personas and complete campaigns with Gemini AI (standard quality).",
    price: "Free",
    cycle: "mo",
    monthlyUsd: null,
    features: [
      "1,500 AI Credits / mo",
      "1 Persona",
      "Campaign & plan generation",
      "Gemini AI (standard quality)",
    ],
    // Enough for ~2 full persona → campaign → plan loops (600 credits each).
    creditsTotal: 1500,
    seatsLimit: 1,
    projects: "1 active",
    apiPriority: "Standard",
  },
  pro: {
    name: "Pro",
    description: "More capacity with higher-quality Claude AI.",
    price: "$49",
    cycle: "mo",
    monthlyUsd: 49,
    features: [
      "5,000 AI Credits / mo",
      "5 Personas",
      "Claude AI (higher quality)",
      "Email support",
    ],
    creditsTotal: 5000,
    seatsLimit: 5,
    projects: "Unlimited",
    apiPriority: "Standard",
  },
  enterprise: {
    name: "Enterprise",
    description: "More capacity and priority support for scaling teams.",
    price: "$79",
    cycle: "mo",
    monthlyUsd: 79,
    features: [
      "15,000 AI Credits / mo",
      "Unlimited personas",
      "Claude AI (highest quality)",
      "Priority support",
    ],
    creditsTotal: 15000,
    seatsLimit: 10,
    projects: "Unlimited",
    apiPriority: "High",
  },
};

export function getTierCatalog() {
  return TIER_CATALOG;
}

export function normalizeBillingInterval(value: string | null | undefined): BillingInterval {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "yearly" || v === "annual" || v === "year") return "yearly";
  return "monthly";
}

export function intervalFromBillingCycle(billingCycle: string | null | undefined): BillingInterval {
  return /year/i.test(String(billingCycle ?? "")) ? "yearly" : "monthly";
}

function formatUsd(amount: number): string {
  if (Number.isInteger(amount)) return `$${amount}`;
  return `$${amount.toFixed(2)}`;
}

/** Annual total in USD (10 months charged). */
export function yearlyTotalUsd(planId: PlanTierId): number | null {
  const monthly = TIER_CATALOG[planId].monthlyUsd;
  if (monthly == null) return null;
  return monthly * ANNUAL_MONTHS_CHARGED;
}

/** Monthly-equivalent display when billed yearly. */
export function yearlyEquivalentMonthlyUsd(planId: PlanTierId): number | null {
  const total = yearlyTotalUsd(planId);
  if (total == null) return null;
  return Math.round((total / 12) * 100) / 100;
}

export function getTierPricing(
  planId: PlanTierId,
  interval: BillingInterval = "monthly"
): {
  price: string;
  cycle: string | null;
  billingCycle: string;
  yearlyTotal: string | null;
  savingsLabel: string | null;
} {
  const tier = TIER_CATALOG[planId];
  if (planId === "free" || tier.monthlyUsd == null) {
    return {
      price: "Free",
      cycle: "mo",
      billingCycle: "Free",
      yearlyTotal: null,
      savingsLabel: null,
    };
  }

  if (interval === "yearly") {
    const equiv = yearlyEquivalentMonthlyUsd(planId)!;
    const total = yearlyTotalUsd(planId)!;
    return {
      price: formatUsd(equiv),
      cycle: "mo",
      billingCycle: "Billed yearly",
      yearlyTotal: formatUsd(total),
      savingsLabel: "2 months free",
    };
  }

  return {
    price: formatUsd(tier.monthlyUsd),
    cycle: "mo",
    billingCycle: "Billed monthly",
    yearlyTotal: null,
    savingsLabel: null,
  };
}

/** Persist display price + billing cycle for the chosen interval. */
export async function applyBillingIntervalDisplay(
  userId: string,
  planId: PlanTierId,
  interval: BillingInterval
): Promise<void> {
  const pricing = getTierPricing(planId, interval);
  const { error } = await supabaseAdmin
    .from("billing_accounts")
    .update({
      plan_price: pricing.price,
      plan_cycle: pricing.cycle,
      billing_cycle: pricing.billingCycle,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (error) {
    console.warn("[billing] applyBillingIntervalDisplay:", error.message);
  }
}

/** Normalize legacy `scale` plan ids to `enterprise`. */
export function normalizePlanId(planId: string | null | undefined): PlanTierId {
  if (planId === "enterprise" || planId === "pro" || planId === "free") return planId;
  if (planId === "scale") return "enterprise";
  return "free";
}

/** True once a paid period has run out. Missing dates count as expired. */
export function periodHasEnded(renewsOn: string | null): boolean {
  if (!renewsOn) return true;
  const end = new Date(renewsOn).getTime();
  if (Number.isNaN(end)) return true;
  return end <= Date.now();
}

/**
 * Whole UTC calendar days from today until `renewsOn` (negative once past).
 * Used for 7 / 3 / 1 day renewal reminders.
 */
export function calendarDaysUntil(renewsOn: string | null): number | null {
  if (!renewsOn) return null;
  const end = new Date(renewsOn);
  if (Number.isNaN(end.getTime())) return null;
  const utcEnd = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const now = new Date();
  const utcToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((utcEnd - utcToday) / 86_400_000);
}

/** Raw row load / create. Does not apply period transitions (safe for changePlan). */
async function loadOrCreateBillingAccount(userId: string): Promise<BillingAccountRow> {
  const { data, error } = await supabaseAdmin
    .from("billing_accounts")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (data) {
    const raw = data as BillingAccountRow & { plan_id: string };
    const planId = normalizePlanId(raw.plan_id);
    const account = { ...raw, plan_id: planId };
    // Keep Free pools aligned with catalog so persona → campaign → plan fits, still below paid.
    const freePool = TIER_CATALOG.free.creditsTotal ?? 0;
    if (planId === "free" && freePool > 0 && account.credits_total !== freePool) {
      const { data: updated, error: updateError } = await supabaseAdmin
        .from("billing_accounts")
        .update({
          credits_total: freePool,
          credits_used: Math.min(account.credits_used, freePool),
          projects: TIER_CATALOG.free.projects,
          plan_name: TIER_CATALOG.free.name,
          plan_price: TIER_CATALOG.free.price,
          plan_cycle: TIER_CATALOG.free.cycle,
        })
        .eq("user_id", userId)
        .select("*")
        .single();
      if (!updateError && updated) {
        return { ...(updated as BillingAccountRow), plan_id: "free" };
      }
    }
    return account;
  }

  const renewsOn = new Date();
  renewsOn.setDate(renewsOn.getDate() + 30);
  const defaultTier = TIER_CATALOG.free;

  const { data: created, error: insertError } = await supabaseAdmin
    .from("billing_accounts")
    .upsert(
      {
        user_id: userId,
        plan_id: "free",
        plan_name: defaultTier.name,
        plan_price: defaultTier.price,
        plan_cycle: defaultTier.cycle,
        billing_cycle: "Billed monthly",
        renews_on: renewsOn.toISOString(),
        credits_total: defaultTier.creditsTotal,
        seats_limit: defaultTier.seatsLimit,
        projects: defaultTier.projects,
        api_priority: defaultTier.apiPriority,
      },
      { onConflict: "user_id" }
    )
    .select("*")
    .single();

  if (insertError || !created) {
    throw new Error(insertError?.message || "Failed to create billing account");
  }

  return created as BillingAccountRow;
}

async function notifySubscriptionExpired(userId: string, planName: string): Promise<void> {
  try {
    const { createNotification } = await import("./notifications");
    await createNotification(userId, {
      category: "billing",
      title: "Subscription expired",
      description: `Your ${planName} plan has ended. You're back on the Free plan. Upgrade anytime to restore paid credits and limits.`,
      actionLabel: "View Billing",
      actionHref: "/dashboard/billing",
      actionTone: "warning",
    });
  } catch (err) {
    console.error("[billing] subscription-expired notification failed", err);
  }
}

/**
 * Downgrade when the paid window is over and renewal did not happen:
 * cancelled-at-period-end, or a paid plan with no live Stripe/Paystack subscription
 * (manual grants and failed renewals with no processor).
 */
async function lapseExpiredPaidPlan(account: BillingAccountRow): Promise<BillingAccountRow | null> {
  const planId = normalizePlanId(account.plan_id);
  if (planId === "free" || !periodHasEnded(account.renews_on)) return null;

  const cancelled = account.cancel_at_period_end === true;
  const hasProvider = await hasActiveProviderSubscription(account.user_id);
  if (!cancelled && hasProvider) return null;

  const previousName = account.plan_name || TIER_CATALOG[planId].name;
  const lapsed = await changePlan(account.user_id, "free");
  await setCancelAtPeriodEnd(account.user_id, false);
  await setPendingPlanChange(account.user_id, null, null);
  await notifySubscriptionExpired(account.user_id, previousName);
  return {
    ...lapsed,
    cancel_at_period_end: false,
    pending_plan_id: null,
    pending_plan_starts_on: null,
  };
}

/**
 * Flags whether the plan should lapse at the end of the paid period, optionally pinning
 * the date access runs out. Tolerates the column being absent so an unmigrated DB
 * degrades to a warning rather than a failed request.
 */
export async function setCancelAtPeriodEnd(
  userId: string,
  cancelling: boolean,
  accessUntil?: string | null
): Promise<void> {
  const patch: Record<string, unknown> = {
    cancel_at_period_end: cancelling,
    updated_at: new Date().toISOString(),
  };
  if (accessUntil) patch.renews_on = accessUntil;

  const { error } = await supabaseAdmin
    .from("billing_accounts")
    .update(patch)
    .eq("user_id", userId);

  if (error) {
    console.warn("[billing] setCancelAtPeriodEnd:", error.message);
  }
}

/**
 * Records the tier this account switches to when the paid period ends. Pass a null
 * `planId` to drop a scheduled change. Tolerates the columns being absent.
 */
export async function setPendingPlanChange(
  userId: string,
  planId: PlanTierId | null,
  startsOn: string | null
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("billing_accounts")
    .update({
      pending_plan_id: planId,
      pending_plan_starts_on: planId ? startsOn : null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (error) {
    console.warn("[billing] setPendingPlanChange:", error.message);
  }
}

/** Long-form date for user-facing copy, e.g. "March 14, 2026". */
export function formatPlanDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Which processor holds this user's live subscription, if any. */
export async function activeSubscriptionProvider(
  userId: string
): Promise<"stripe" | "paystack" | null> {
  const { data, error } = await supabaseAdmin
    .from("billing_accounts")
    .select("stripe_subscription_id, paystack_subscription_code")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return null;

  const row = data as {
    stripe_subscription_id?: string | null;
    paystack_subscription_code?: string | null;
  } | null;

  if (row?.stripe_subscription_id) return "stripe";
  if (row?.paystack_subscription_code) return "paystack";
  return null;
}

/** True when either processor still holds a live subscription for this user. */
export async function hasActiveProviderSubscription(userId: string): Promise<boolean> {
  return (await activeSubscriptionProvider(userId)) !== null;
}

export async function ensureBillingAccount(userId: string): Promise<BillingAccountRow> {
  const raw = await loadOrCreateBillingAccount(userId);
  const planId = normalizePlanId(raw.plan_id);

  // Webhooks normally expire plans; this catch-up means a missed event cannot leave
  // paid access open after renews_on (cancelled renewals and orphaned manual grants).
  const lapsed = await lapseExpiredPaidPlan({ ...raw, plan_id: planId });
  if (lapsed) return lapsed;

  // A scheduled downgrade lands here if the processor's event was missed.
  if (raw.pending_plan_id && raw.pending_plan_starts_on && periodHasEnded(raw.pending_plan_starts_on)) {
    const pending = normalizePlanId(raw.pending_plan_id);
    const switched = await changePlan(userId, pending);
    await setPendingPlanChange(userId, null, null);
    return { ...switched, pending_plan_id: null, pending_plan_starts_on: null };
  }

  const tier = TIER_CATALOG[planId];
  const interval = intervalFromBillingCycle(raw.billing_cycle);
  const pricing = getTierPricing(planId, interval);
  const needsSync =
    raw.plan_id !== planId ||
    raw.plan_price !== pricing.price ||
    raw.plan_name !== tier.name ||
    raw.plan_cycle !== (pricing.cycle || raw.plan_cycle) ||
    raw.billing_cycle !== pricing.billingCycle;

  if (needsSync) {
    const { data: synced } = await supabaseAdmin
      .from("billing_accounts")
      .update({
        plan_id: planId,
        plan_name: tier.name,
        plan_price: pricing.price,
        plan_cycle: pricing.cycle,
        billing_cycle: pricing.billingCycle,
        seats_limit: tier.seatsLimit,
        projects: tier.projects,
        api_priority: tier.apiPriority,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();
    if (synced) return { ...(synced as BillingAccountRow), plan_id: planId };
  }
  return { ...raw, plan_id: planId };
}

export async function changePlan(userId: string, planId: PlanTierId): Promise<BillingAccountRow> {
  const normalized = normalizePlanId(planId);
  const tier = TIER_CATALOG[normalized];
  // Avoid ensureBillingAccount here: period-lapse calls changePlan and would recurse.
  const current = await loadOrCreateBillingAccount(userId);

  // Same-plan renewal / webhook replay must not reset credit balances or seats.
  if (current.plan_id === normalized) {
    return current;
  }

  const { data, error } = await supabaseAdmin
    .from("billing_accounts")
    .update({
      plan_id: normalized,
      plan_name: tier.name,
      plan_price: tier.price,
      plan_cycle: tier.cycle,
      credits_total: tier.creditsTotal,
      seats_limit: tier.seatsLimit,
      projects: tier.projects,
      api_priority: tier.apiPriority,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to change plan");
  }

  return { ...(data as BillingAccountRow), plan_id: normalized };
}

export async function updateBillingAddress(
  userId: string,
  address: {
    company: string;
    line1: string;
    line2: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  }
): Promise<BillingAccountRow> {
  await ensureBillingAccount(userId);

  const { data, error } = await supabaseAdmin
    .from("billing_accounts")
    .update({
      billing_company: address.company,
      billing_line1: address.line1,
      billing_line2: address.line2,
      billing_city: address.city,
      billing_state: address.state,
      billing_postal_code: address.postalCode,
      billing_country: address.country,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to update billing address");
  }

  return data as BillingAccountRow;
}

export async function listPaymentMethods(userId: string): Promise<PaymentMethodRow[]> {
  const { data, error } = await supabaseAdmin
    .from("payment_methods")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return (data as PaymentMethodRow[]) ?? [];
}

export async function addPaymentMethod(
  userId: string,
  input: { brand: "visa" | "mastercard"; last4: string; expiry: string; isPrimary?: boolean }
): Promise<PaymentMethodRow> {
  const existing = await listPaymentMethods(userId);
  const shouldBePrimary = input.isPrimary || existing.length === 0;

  if (shouldBePrimary && existing.length > 0) {
    await supabaseAdmin.from("payment_methods").update({ is_primary: false }).eq("user_id", userId);
  }

  const { data, error } = await supabaseAdmin
    .from("payment_methods")
    .insert({
      user_id: userId,
      brand: input.brand,
      last4: input.last4,
      expiry: input.expiry,
      is_primary: shouldBePrimary,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to add payment method");
  }

  return data as PaymentMethodRow;
}

export async function deletePaymentMethod(userId: string, id: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("payment_methods")
    .delete()
    .eq("user_id", userId)
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return Boolean(data);
}

export async function setPrimaryPaymentMethod(userId: string, id: string): Promise<PaymentMethodRow | null> {
  const { data: target, error: fetchError } = await supabaseAdmin
    .from("payment_methods")
    .select("id")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!target) return null;

  await supabaseAdmin.from("payment_methods").update({ is_primary: false }).eq("user_id", userId);

  const { data, error } = await supabaseAdmin
    .from("payment_methods")
    .update({ is_primary: true })
    .eq("user_id", userId)
    .eq("id", id)
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message || "Failed to set primary payment method");
  return data as PaymentMethodRow;
}

export function toPaymentMethod(row: PaymentMethodRow) {
  return {
    id: row.id,
    brand: row.brand,
    last4: row.last4,
    expiry: row.expiry,
    isPrimary: row.is_primary,
  };
}

export const CREDIT_COSTS = {
  persona: 250,
  campaign: 150,
  plan: 200,
} as const;

export class InsufficientCreditsError extends Error {
  constructor(public remaining: number, public required: number) {
    super(`Not enough credits. Need ${required}, have ${remaining}.`);
    this.name = "InsufficientCreditsError";
  }
}

/** Deducts credits and records a ledger event. Throws InsufficientCreditsError if short. */
export async function consumeCredits(
  userId: string,
  amount: number,
  reason: string,
  businessId?: string | null
): Promise<BillingAccountRow> {
  // Platform admins use Convert Tide free: no credit deduction.
  const { isAdminUserId } = await import("./admin");
  if (await isAdminUserId(userId)) {
    const account = await ensureBillingAccount(userId);
    const { error: eventError } = await supabaseAdmin.from("billing_credit_events").insert({
      user_id: userId,
      amount: 0,
      reason: `${reason}_admin_free`,
      ...(businessId ? { business_id: businessId } : {}),
    });
    if (eventError) {
      console.error("[billing] failed to record admin credit event", eventError.message);
    }
    return account;
  }

  // Optimistic lock + one retry so concurrent generates cannot overspend the plan pool.
  let account = await ensureBillingAccount(userId);
  let updated: BillingAccountRow | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = Math.max(0, account.credits_total - account.credits_used);
    if (amount > remaining) {
      throw new InsufficientCreditsError(remaining, amount);
    }

    const nextUsed = account.credits_used + amount;
    const { data, error } = await supabaseAdmin
      .from("billing_accounts")
      .update({
        credits_used: nextUsed,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("credits_used", account.credits_used)
      .select("*")
      .maybeSingle();

    if (error) {
      throw new Error(error.message || "Failed to update credits");
    }
    if (data) {
      updated = data as BillingAccountRow;
      break;
    }

    account = await ensureBillingAccount(userId);
  }

  if (!updated) {
    const remaining = Math.max(0, account.credits_total - account.credits_used);
    throw new InsufficientCreditsError(remaining, amount);
  }

  const { error: eventError } = await supabaseAdmin.from("billing_credit_events").insert({
    user_id: userId,
    amount,
    reason,
    ...(businessId ? { business_id: businessId } : {}),
  });

  if (eventError) {
    console.error("[billing] failed to record credit event", eventError.message);
  }

  // Per-business quota tracking (OB-003) — independent usage history per profile.
  if (businessId) {
    const { data: bizRow } = await supabaseAdmin
      .from("business_profiles")
      .select("credits_used")
      .eq("id", businessId)
      .eq("user_id", userId)
      .maybeSingle();

    if (bizRow) {
      const bizUsed = (bizRow as { credits_used?: number }).credits_used ?? 0;
      const { error: bizError } = await supabaseAdmin
        .from("business_profiles")
        .update({
          credits_used: bizUsed + amount,
          updated_at: new Date().toISOString(),
        })
        .eq("id", businessId)
        .eq("user_id", userId);

      if (bizError) {
        console.error("[billing] failed to update business credits", bizError.message);
      }
    }
  }

  const remainingAfter = Math.max(0, updated.credits_total - updated.credits_used);
  const remainingBefore = remainingAfter + amount;
  const threshold = Math.max(1, Math.floor(updated.credits_total * 0.2));
  // Notify once when remaining credits cross below 20%.
  if (remainingBefore >= threshold && remainingAfter < threshold) {
    const { createNotification } = await import("./notifications");
    void createNotification(userId, {
      category: "ai",
      title: "AI credits running low",
      description: `You have ${remainingAfter} credits left (under 20% of your plan). Top up or upgrade to keep generating.`,
      actionLabel: "View Billing",
      actionHref: "/dashboard/billing",
      actionTone: "warning",
    }).catch((err) => {
      console.error("[billing] credits-low notification failed", err);
    });
  }

  return updated;
}

/** Monthly credit spend for a calendar year (Jan–Dec). Missing months are 0. */
export async function getMonthlyCreditUsage(
  userId: string,
  year: number,
  businessId?: string | null
): Promise<number[]> {
  const start = new Date(Date.UTC(year, 0, 1)).toISOString();
  const end = new Date(Date.UTC(year + 1, 0, 1)).toISOString();

  let query = supabaseAdmin
    .from("billing_credit_events")
    .select("amount, created_at")
    .eq("user_id", userId)
    .gte("created_at", start)
    .lt("created_at", end);

  if (businessId) {
    query = query.eq("business_id", businessId);
  }

  const { data, error } = await query;

  if (error) throw new Error(error.message);

  const months = Array.from({ length: 12 }, () => 0);
  for (const row of data ?? []) {
    const month = new Date(row.created_at as string).getUTCMonth();
    months[month] += Number(row.amount) || 0;
  }
  return months;
}

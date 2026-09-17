import { supabaseAdmin } from "../config/supabase";

export type PlanTierId = "free" | "pro" | "enterprise";

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
// they're product config, not per-user data.
const TIER_CATALOG: Record<
  PlanTierId,
  {
    name: string;
    description: string;
    price: string;
    cycle: string | null;
    features: string[];
    creditsTotal: number | null;
    seatsLimit: number | null;
    projects: string;
    apiPriority: string;
  }
> = {
  free: {
    name: "Free",
    description: "Get started with core AI marketing tools.",
    price: "Free",
    cycle: "mo",
    features: ["500 AI Credits / mo", "1 Persona", "Basic campaign copy"],
    creditsTotal: 500,
    seatsLimit: 1,
    projects: "1 active",
    apiPriority: "Standard",
  },
  pro: {
    name: "Pro",
    description: "For growing teams running multiple campaigns.",
    price: "$49",
    cycle: "mo",
    features: ["5,000 AI Credits / mo", "5 Personas", "Email support"],
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
    features: ["15,000 AI Credits / mo", "Unlimited personas", "Priority support"],
    creditsTotal: 15000,
    seatsLimit: 10,
    projects: "Unlimited",
    apiPriority: "High",
  },
};

export function getTierCatalog() {
  return TIER_CATALOG;
}

/** Normalize legacy `scale` plan ids to `enterprise`. */
export function normalizePlanId(planId: string | null | undefined): PlanTierId {
  if (planId === "enterprise" || planId === "pro" || planId === "free") return planId;
  if (planId === "scale") return "enterprise";
  return "free";
}

/** True once a paid period has run out. Missing dates count as expired. */
function periodHasEnded(renewsOn: string | null): boolean {
  if (!renewsOn) return true;
  const end = new Date(renewsOn).getTime();
  if (Number.isNaN(end)) return true;
  return end <= Date.now();
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
  const { data, error } = await supabaseAdmin
    .from("billing_accounts")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (data) {
    const raw = data as BillingAccountRow & { plan_id: string };
    const planId = normalizePlanId(raw.plan_id);

    // A cancelled plan keeps working until the paid period runs out. Webhooks normally
    // do this downgrade; checking here means a missed webhook can't grant free access.
    if (raw.cancel_at_period_end && planId !== "free" && periodHasEnded(raw.renews_on)) {
      const lapsed = await changePlan(userId, "free");
      await setCancelAtPeriodEnd(userId, false);
      await setPendingPlanChange(userId, null, null);
      return { ...lapsed, cancel_at_period_end: false, pending_plan_id: null, pending_plan_starts_on: null };
    }

    // A scheduled downgrade lands here if the processor's event was missed.
    if (raw.pending_plan_id && raw.pending_plan_starts_on && periodHasEnded(raw.pending_plan_starts_on)) {
      const pending = normalizePlanId(raw.pending_plan_id);
      const switched = await changePlan(userId, pending);
      await setPendingPlanChange(userId, null, null);
      return { ...switched, pending_plan_id: null, pending_plan_starts_on: null };
    }

    const tier = TIER_CATALOG[planId];
    const needsSync =
      raw.plan_id !== planId ||
      raw.plan_price !== tier.price ||
      raw.plan_name !== tier.name ||
      raw.plan_cycle !== (tier.cycle || raw.plan_cycle);

    if (needsSync) {
      const { data: synced } = await supabaseAdmin
        .from("billing_accounts")
        .update({
          plan_id: planId,
          plan_name: tier.name,
          plan_price: tier.price,
          plan_cycle: tier.cycle,
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

export async function changePlan(userId: string, planId: PlanTierId): Promise<BillingAccountRow> {
  const normalized = normalizePlanId(planId);
  const tier = TIER_CATALOG[normalized];

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
  reason: string
): Promise<BillingAccountRow> {
  const account = await ensureBillingAccount(userId);
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
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to update credits");
  }

  const { error: eventError } = await supabaseAdmin.from("billing_credit_events").insert({
    user_id: userId,
    amount,
    reason,
  });

  if (eventError) {
    console.error("[billing] failed to record credit event", eventError.message);
  }

  const updated = data as BillingAccountRow;
  const remainingAfter = Math.max(0, updated.credits_total - updated.credits_used);
  const threshold = Math.max(1, Math.floor(updated.credits_total * 0.2));
  // Notify once when remaining credits cross below 20%.
  if (remaining >= threshold && remainingAfter < threshold) {
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
  year: number
): Promise<number[]> {
  const start = new Date(Date.UTC(year, 0, 1)).toISOString();
  const end = new Date(Date.UTC(year + 1, 0, 1)).toISOString();

  const { data, error } = await supabaseAdmin
    .from("billing_credit_events")
    .select("amount, created_at")
    .eq("user_id", userId)
    .gte("created_at", start)
    .lt("created_at", end);

  if (error) throw new Error(error.message);

  const months = Array.from({ length: 12 }, () => 0);
  for (const row of data ?? []) {
    const month = new Date(row.created_at as string).getUTCMonth();
    months[month] += Number(row.amount) || 0;
  }
  return months;
}

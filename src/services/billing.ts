import { supabaseAdmin } from "../config/supabase";

export type PlanTierId = "pro" | "scale" | "enterprise";

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
  pro: {
    name: "Pro",
    description: "Essential AI tools for growing marketing teams.",
    price: "$149",
    cycle: "mo",
    features: ["2,500 AI Credits / mo", "5 Team Seats", "Standard Support"],
    creditsTotal: 2500,
    seatsLimit: 5,
    projects: "Unlimited",
    apiPriority: "Standard",
  },
  scale: {
    name: "Scale",
    description: "Advanced automation and deep analytics for high-performance agencies.",
    price: "$499",
    cycle: "mo",
    features: ["10,000 AI Credits / mo", "25 Team Seats", "Priority Support"],
    creditsTotal: 10000,
    seatsLimit: 25,
    projects: "Unlimited",
    apiPriority: "High",
  },
  enterprise: {
    name: "Enterprise",
    description: "Custom scale, security, and white-labeling for global corporations.",
    price: "Custom",
    cycle: null,
    features: ["Unlimited AI Credits", "Custom Onboarding", "SLA & Dedicated CSM"],
    creditsTotal: null,
    seatsLimit: null,
    projects: "Unlimited",
    apiPriority: "Dedicated",
  },
};

export function getTierCatalog() {
  return TIER_CATALOG;
}

export async function ensureBillingAccount(userId: string): Promise<BillingAccountRow> {
  const { data, error } = await supabaseAdmin
    .from("billing_accounts")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (data) return data as BillingAccountRow;

  const renewsOn = new Date();
  renewsOn.setDate(renewsOn.getDate() + 30);
  const defaultTier = TIER_CATALOG.pro;

  const { data: created, error: insertError } = await supabaseAdmin
    .from("billing_accounts")
    .upsert(
      {
        user_id: userId,
        plan_id: "pro",
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

export async function changePlan(userId: string, planId: "pro" | "scale"): Promise<BillingAccountRow> {
  const tier = TIER_CATALOG[planId];

  const { data, error } = await supabaseAdmin
    .from("billing_accounts")
    .update({
      plan_id: planId,
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

  return data as BillingAccountRow;
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

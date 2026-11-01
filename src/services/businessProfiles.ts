import { supabaseAdmin } from "../config/supabase";
import { logAccountAudit } from "./accountAudit";

export type BusinessProfile = {
  id: string;
  userId: string;
  name: string;
  industry: string;
  isDefault: boolean;
  creditsUsed: number;
  creditsTotal: number | null;
  createdAt: string;
  updatedAt: string;
};

type BusinessRow = {
  id: string;
  user_id: string;
  name: string;
  industry: string;
  is_default: boolean;
  credits_used: number;
  credits_total: number | null;
  created_at: string;
  updated_at: string;
};

function toBusiness(row: BusinessRow): BusinessProfile {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    industry: row.industry ?? "",
    isDefault: Boolean(row.is_default),
    creditsUsed: row.credits_used ?? 0,
    creditsTotal: row.credits_total,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listBusinessProfiles(userId: string): Promise<BusinessProfile[]> {
  const { data, error } = await supabaseAdmin
    .from("business_profiles")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return ((data ?? []) as BusinessRow[]).map(toBusiness);
}

/** Ensures the user has at least one business and an active selection. */
export async function ensureDefaultBusiness(userId: string): Promise<BusinessProfile> {
  const existing = await listBusinessProfiles(userId);
  if (existing.length > 0) {
    const activeId = await getActiveBusinessId(userId);
    const active = existing.find((b) => b.id === activeId) ?? existing.find((b) => b.isDefault) ?? existing[0];
    if (active && active.id !== activeId) {
      await setActiveBusiness(userId, active.id);
    }
    return active;
  }

  const { data, error } = await supabaseAdmin
    .from("business_profiles")
    .insert({
      user_id: userId,
      name: "My business",
      industry: "",
      is_default: true,
    })
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message || "Failed to create business profile");

  const business = toBusiness(data as BusinessRow);
  await setActiveBusiness(userId, business.id);
  await logAccountAudit({
    userId,
    action: "business_created",
    actor: "system",
    businessId: business.id,
    metadata: { name: business.name, default: true },
  });
  return business;
}

export async function getActiveBusinessId(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("active_business_id")
    .eq("user_id", userId)
    .maybeSingle();

  return (data as { active_business_id?: string | null } | null)?.active_business_id ?? null;
}

export async function getBusinessForUser(
  userId: string,
  businessId: string
): Promise<BusinessProfile | null> {
  const { data, error } = await supabaseAdmin
    .from("business_profiles")
    .select("*")
    .eq("user_id", userId)
    .eq("id", businessId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? toBusiness(data as BusinessRow) : null;
}

export async function setActiveBusiness(userId: string, businessId: string): Promise<BusinessProfile> {
  const business = await getBusinessForUser(userId, businessId);
  if (!business) {
    const err = new Error("Business not found") as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const { error } = await supabaseAdmin
    .from("profiles")
    .upsert(
      {
        user_id: userId,
        active_business_id: businessId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

  if (error) throw new Error(error.message);

  await logAccountAudit({
    userId,
    action: "business_switched",
    actor: "user",
    businessId,
    metadata: { name: business.name },
  });

  return business;
}

export async function createBusinessProfile(
  userId: string,
  input: { name: string; industry?: string }
): Promise<BusinessProfile> {
  const name = input.name.trim();
  if (!name) {
    const err = new Error("Business name is required") as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  const existing = await listBusinessProfiles(userId);
  const makeDefault = existing.length === 0;

  const { data, error } = await supabaseAdmin
    .from("business_profiles")
    .insert({
      user_id: userId,
      name,
      industry: (input.industry ?? "").trim(),
      is_default: makeDefault,
    })
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message || "Failed to create business");

  const business = toBusiness(data as BusinessRow);
  if (makeDefault) await setActiveBusiness(userId, business.id);

  await logAccountAudit({
    userId,
    action: "business_created",
    actor: "user",
    businessId: business.id,
    metadata: { name: business.name },
  });

  return business;
}

export async function updateBusinessProfile(
  userId: string,
  businessId: string,
  patch: { name?: string; industry?: string }
): Promise<BusinessProfile> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) {
      const err = new Error("Business name is required") as Error & { status?: number };
      err.status = 400;
      throw err;
    }
    updates.name = name;
  }
  if (patch.industry !== undefined) updates.industry = patch.industry.trim();

  const { data, error } = await supabaseAdmin
    .from("business_profiles")
    .update(updates)
    .eq("user_id", userId)
    .eq("id", businessId)
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) {
    const err = new Error("Business not found") as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  await logAccountAudit({
    userId,
    action: "business_updated",
    actor: "user",
    businessId,
    metadata: patch,
  });

  return toBusiness(data as BusinessRow);
}

/**
 * Resolves the business for this request. Prefers X-Business-Id when it belongs
 * to the user; otherwise falls back to the active / default business.
 */
export async function resolveBusinessContext(
  userId: string,
  headerBusinessId?: string | null
): Promise<BusinessProfile> {
  if (headerBusinessId) {
    const owned = await getBusinessForUser(userId, headerBusinessId);
    if (owned) return owned;

    await logAccountAudit({
      userId,
      action: "business_access_denied",
      actor: "user",
      businessId: headerBusinessId,
      metadata: { reason: "not_owned" },
    });

    const err = new Error("You do not have access to that business profile.") as Error & {
      status?: number;
    };
    err.status = 403;
    throw err;
  }

  return ensureDefaultBusiness(userId);
}

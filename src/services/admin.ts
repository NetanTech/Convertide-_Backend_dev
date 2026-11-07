import * as crypto from "node:crypto";
import { supabaseAdmin } from "../config/supabase";

const DEFAULT_ADMIN_EMAILS = [
  "converttidedev@gmail.com",
  "hamzatajibola401@gmail.com",
  "segunabraham96@gmail.com",
];

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function fallbackAdminEmails(): string[] {
  const fromEnv = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => normalizeEmail(e))
    .filter(Boolean);
  return [...new Set([...DEFAULT_ADMIN_EMAILS.map(normalizeEmail), ...fromEnv])];
}

/** @deprecated Prefer async isAdminEmail; sync fallback for token payload checks. */
export function adminEmails(): string[] {
  return fallbackAdminEmails();
}

function adminUsersMissing(errorMessage: string) {
  return /admin_users|schema cache|does not exist/i.test(errorMessage);
}

let seedAttempted = false;

async function ensureAdminUsersSeeded(): Promise<void> {
  if (seedAttempted) return;
  seedAttempted = true;
  const rows = fallbackAdminEmails().map((email) => ({ email, role: "admin" as const }));
  const { error } = await supabaseAdmin.from("admin_users").upsert(rows, { onConflict: "email" });
  if (error && !adminUsersMissing(error.message)) {
    console.warn("[admin] seed admin_users:", error.message);
  }
}

export async function isAdminEmail(email?: string | null): Promise<boolean> {
  if (!email) return false;
  const normalized = normalizeEmail(email);
  await ensureAdminUsersSeeded();
  const { data, error } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("email", normalized)
    .maybeSingle();
  if (!error) return Boolean(data);
  if (adminUsersMissing(error.message)) {
    return fallbackAdminEmails().includes(normalized);
  }
  throw new Error(error.message);
}

export async function isAdminUserId(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error || !data?.user?.email) return false;
  return isAdminEmail(data.user.email);
}

export async function listStaffAdmins() {
  await ensureAdminUsersSeeded();
  const { data, error } = await supabaseAdmin
    .from("admin_users")
    .select("email, role, added_by, created_at")
    .order("created_at", { ascending: true });
  if (error) {
    if (adminUsersMissing(error.message)) {
      return fallbackAdminEmails().map((email) => ({
        email,
        role: "admin" as const,
        addedBy: null as string | null,
        createdAt: null as string | null,
      }));
    }
    throw new Error(error.message);
  }
  return (data ?? []).map((row) => {
    const r = row as {
      email: string;
      role: string;
      added_by: string | null;
      created_at: string;
    };
    return {
      email: r.email,
      role: r.role,
      addedBy: r.added_by,
      createdAt: r.created_at,
    };
  });
}

export async function addStaffAdmin(email: string, addedByUserId: string) {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Enter a valid email address.");
  }
  await ensureAdminUsersSeeded();
  if (await isAdminEmail(normalized)) {
    throw new Error("That email is already an admin.");
  }
  const { error } = await supabaseAdmin.from("admin_users").insert({
    email: normalized,
    role: "admin",
    added_by: addedByUserId,
  });
  if (error) {
    if (adminUsersMissing(error.message)) {
      throw new Error("Admin users table is missing. Run migrations/025_admin_users.sql in Supabase.");
    }
    throw new Error(error.message);
  }
  return { email: normalized, role: "admin" as const };
}

const ADMIN_PASSWORD_KEY = "unlock_password_hash";
const MIN_ADMIN_PASSWORD_LENGTH = 8;
const SCRYPT_KEYLEN = 64;

function adminTokenSecret() {
  return (
    process.env.ADMIN_TOKEN_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "convertide-admin-dev"
  );
}

function hashAdminPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function verifyPasswordHash(password: string, stored: string): boolean {
  const [algo, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;
  try {
    const salt = Buffer.from(saltB64, "base64url");
    const expected = Buffer.from(hashB64, "base64url");
    const actual = crypto.scryptSync(password, salt, expected.length);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function validateAdminPasswordStrength(password: string): string | null {
  if (!password || password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return `Admin password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

function adminSettingsMissingMessage(errorMessage: string) {
  if (/admin_settings|schema cache|does not exist/i.test(errorMessage)) {
    return "Admin settings table is missing. Run migrations/024_admin_settings.sql in Supabase.";
  }
  return errorMessage;
}

async function getStoredPasswordHash(): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("admin_settings")
    .select("value")
    .eq("key", ADMIN_PASSWORD_KEY)
    .maybeSingle();
  if (error) throw new Error(adminSettingsMissingMessage(error.message));
  const value = (data as { value?: string } | null)?.value;
  return value?.trim() || null;
}

export async function isAdminPasswordConfigured(): Promise<boolean> {
  return Boolean(await getStoredPasswordHash());
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
  if (!password) return false;
  const stored = await getStoredPasswordHash();
  if (!stored) return false;
  return verifyPasswordHash(password, stored);
}

export async function setAdminPassword(password: string, updatedBy: string): Promise<void> {
  const strengthError = validateAdminPasswordStrength(password);
  if (strengthError) throw new Error(strengthError);
  const value = hashAdminPassword(password);
  const { error } = await supabaseAdmin.from("admin_settings").upsert(
    {
      key: ADMIN_PASSWORD_KEY,
      value,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    },
    { onConflict: "key" }
  );
  if (error) throw new Error(adminSettingsMissingMessage(error.message));
}

export async function changeAdminPassword(
  currentPassword: string,
  newPassword: string,
  updatedBy: string
): Promise<void> {
  const ok = await verifyAdminPassword(currentPassword);
  if (!ok) throw new Error("Current admin password is wrong.");
  if (currentPassword === newPassword) {
    throw new Error("New password must be different from the current one.");
  }
  await setAdminPassword(newPassword, updatedBy);
}

export function createAdminSessionToken(userId: string, email: string): {
  token: string;
  expiresAt: string;
} {
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  const body = Buffer.from(
    JSON.stringify({ userId, email: normalizeEmail(email), exp }),
    "utf8"
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", adminTokenSecret()).update(body).digest("base64url");
  return {
    token: `${body}.${sig}`,
    expiresAt: new Date(exp).toISOString(),
  };
}

export async function verifyAdminSessionToken(
  token: string,
  expectedUserId: string
): Promise<{ email: string } | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expectedSig = crypto
    .createHmac("sha256", adminTokenSecret())
    .update(body)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      userId?: string;
      email?: string;
      exp?: number;
    };
    if (!parsed.userId || parsed.userId !== expectedUserId) return null;
    if (!parsed.email || !(await isAdminEmail(parsed.email))) return null;
    if (!parsed.exp || parsed.exp < Date.now()) return null;
    return { email: parsed.email };
  } catch {
    return null;
  }
}

export async function listAdminUsers(limit = 100) {
  const perPage = Math.min(Math.max(limit, 1), 200);
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage });
  if (error) throw new Error(error.message);

  const users = data.users ?? [];
  // Use ensureBillingAccount so Free pools match the catalog (1,500) instead of stale 0 rows.
  const { ensureBillingAccount } = await import("./billing");

  return Promise.all(
    users.map(async (u) => {
      let planId = "free";
      let subscriptionStatus: string | null = null;
      let creditsTotal = 0;
      let creditsUsed = 0;
      try {
        const account = await ensureBillingAccount(u.id);
        planId = account.plan_id;
        subscriptionStatus = account.status ?? null;
        creditsTotal = account.credits_total ?? 0;
        creditsUsed = account.credits_used ?? 0;
      } catch (err) {
        console.warn("[admin] billing for user", u.id, err instanceof Error ? err.message : err);
      }
      return {
        id: u.id,
        email: u.email ?? null,
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at ?? null,
        planId,
        subscriptionStatus,
        creditsTotal,
        creditsUsed,
        creditsRemaining: Math.max(0, creditsTotal - creditsUsed),
        isAdmin: await isAdminEmail(u.email),
      };
    })
  );
}

export async function listAdminPayments(limit = 100) {
  const { data, error } = await supabaseAdmin
    .from("billing_accounts")
    .select(
      "user_id, plan_id, status, provider, stripe_customer_id, stripe_subscription_id, current_period_end, credits_total, credits_used, updated_at"
    )
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (missingRelation(error.message)) return [];
    throw new Error(error.message);
  }

  const rows = data ?? [];
  const emails = new Map<string, string | null>();
  await Promise.all(
    rows.map(async (row) => {
      const userId = (row as { user_id: string }).user_id;
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId);
      emails.set(userId, userData.user?.email ?? null);
    })
  );

  return rows.map((row) => {
    const r = row as {
      user_id: string;
      plan_id: string;
      status: string | null;
      provider: string | null;
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
      current_period_end: string | null;
      credits_total: number;
      credits_used: number;
      updated_at: string;
    };
    return {
      userId: r.user_id,
      email: emails.get(r.user_id) ?? null,
      planId: r.plan_id,
      status: r.status,
      provider: r.provider,
      stripeCustomerId: r.stripe_customer_id,
      stripeSubscriptionId: r.stripe_subscription_id,
      currentPeriodEnd: r.current_period_end,
      creditsTotal: r.credits_total,
      creditsUsed: r.credits_used,
      updatedAt: r.updated_at,
    };
  });
}

export async function listAdminCreditEvents(limit = 100) {
  const { data, error } = await supabaseAdmin
    .from("billing_credit_events")
    .select("id, user_id, amount, reason, business_id, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (missingRelation(error.message)) return [];
    throw new Error(error.message);
  }

  const rows = data ?? [];
  const emails = new Map<string, string | null>();
  const uniqueIds = [...new Set(rows.map((r) => (r as { user_id: string }).user_id))];
  await Promise.all(
    uniqueIds.map(async (userId) => {
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId);
      emails.set(userId, userData.user?.email ?? null);
    })
  );

  return rows.map((row) => {
    const r = row as {
      id: string;
      user_id: string;
      amount: number;
      reason: string;
      business_id: string | null;
      created_at: string;
    };
    return {
      id: r.id,
      userId: r.user_id,
      email: emails.get(r.user_id) ?? null,
      amount: r.amount,
      reason: r.reason,
      businessId: r.business_id,
      createdAt: r.created_at,
    };
  });
}

function missingRelation(errorMessage: string) {
  return /schema cache|does not exist|Could not find the table/i.test(errorMessage);
}

export async function listAdminActivity(limit = 100) {
  const { data, error } = await supabaseAdmin
    .from("account_audit_log")
    .select("id, user_id, action, actor, business_id, reference, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (missingRelation(error.message)) return [];
    throw new Error(error.message);
  }

  const rows = data ?? [];
  const uniqueIds = [
    ...new Set(
      rows
        .map((r) => (r as { user_id: string | null }).user_id)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const emails = new Map<string, string | null>();
  await Promise.all(
    uniqueIds.map(async (userId) => {
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId);
      emails.set(userId, userData.user?.email ?? null);
    })
  );

  return rows.map((row) => {
    const r = row as {
      id: number;
      user_id: string | null;
      action: string;
      actor: string;
      business_id: string | null;
      reference: string | null;
      metadata: Record<string, unknown>;
      created_at: string;
    };
    return {
      id: r.id,
      userId: r.user_id,
      email: r.user_id ? emails.get(r.user_id) ?? null : null,
      action: r.action,
      actor: r.actor,
      businessId: r.business_id,
      reference: r.reference,
      metadata: r.metadata,
      createdAt: r.created_at,
    };
  });
}

export async function listAdminSupport(limit = 50) {
  const { data: tickets, error } = await supabaseAdmin
    .from("support_tickets")
    .select("id, user_id, subject, status, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (missingRelation(error.message)) return [];
    throw new Error(error.message);
  }

  const rows = tickets ?? [];
  const uniqueIds = [...new Set(rows.map((r) => (r as { user_id: string }).user_id))];
  const emails = new Map<string, string | null>();
  await Promise.all(
    uniqueIds.map(async (userId) => {
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId);
      emails.set(userId, userData.user?.email ?? null);
    })
  );

  const out = [];
  for (const ticket of rows) {
    const t = ticket as {
      id: string;
      user_id: string;
      subject: string;
      status: string;
      created_at: string;
      updated_at: string;
    };
    const { data: messages } = await supabaseAdmin
      .from("support_messages")
      .select("id, sender, body, created_at")
      .eq("ticket_id", t.id)
      .order("created_at", { ascending: true })
      .limit(100);

    out.push({
      id: t.id,
      userId: t.user_id,
      email: emails.get(t.user_id) ?? null,
      subject: t.subject,
      status: t.status,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      messages: (messages ?? []).map((m) => {
        const msg = m as {
          id: string;
          sender: string;
          body: string;
          created_at: string;
        };
        return {
          id: msg.id,
          role: msg.sender === "support" ? "support" : "user",
          text: msg.body,
          createdAt: msg.created_at,
        };
      }),
    });
  }
  return out;
}

import crypto from "crypto";
import { supabaseAdmin } from "../config/supabase";
import {
  changePlan,
  ensureBillingAccount,
  formatPlanDate,
  getTierCatalog,
  hasActiveProviderSubscription,
  setCancelAtPeriodEnd,
  setPendingPlanChange,
  type PlanTierId,
} from "./billing";
import { createNotification } from "./notifications";
import { appUrl } from "./mailer";
import { cancelOtherProviderSubscription } from "./subscriptionCleanup";

const PAYSTACK_BASE = "https://api.paystack.co";

type PaystackCustomerFields = {
  paystack_customer_code: string | null;
  paystack_subscription_code: string | null;
  paystack_email_token: string | null;
};

type PaystackApiResult<T> = {
  status: boolean;
  message: string;
  data: T;
};

export function isPaystackConfigured() {
  return Boolean(process.env.PAYSTACK_SECRET_KEY?.trim());
}

function secretKey() {
  const key = process.env.PAYSTACK_SECRET_KEY?.trim();
  if (!key) {
    throw new Error("Paystack is not configured. Set PAYSTACK_SECRET_KEY in the backend .env.");
  }
  return key;
}

function planCodeForTier(planId: "pro" | "enterprise"): string {
  const map = {
    pro: process.env.PAYSTACK_PLAN_PRO?.trim() || "",
    enterprise:
      process.env.PAYSTACK_PLAN_ENTERPRISE?.trim() ||
      process.env.PAYSTACK_PLAN_SCALE?.trim() ||
      "",
  };
  const code = map[planId];
  if (!code) {
    throw new Error(`Missing Paystack plan code for ${planId}. Set PAYSTACK_PLAN_${planId.toUpperCase()}.`);
  }
  return code;
}

function planIdFromPlanCode(planCode: string | null | undefined): "pro" | "enterprise" | null {
  if (!planCode) return null;
  if (planCode === process.env.PAYSTACK_PLAN_PRO?.trim()) return "pro";
  if (
    planCode === process.env.PAYSTACK_PLAN_ENTERPRISE?.trim() ||
    planCode === process.env.PAYSTACK_PLAN_SCALE?.trim()
  ) {
    return "enterprise";
  }
  return null;
}

function creditsAddonAmountKobo(): number {
  const raw = process.env.PAYSTACK_CREDITS_ADDON_AMOUNT_KOBO?.trim();
  const amount = raw ? Number(raw) : 0;
  if (!Number.isFinite(amount) || amount < 100) {
    throw new Error(
      "Credit add-ons are not configured. Set PAYSTACK_CREDITS_ADDON_AMOUNT_KOBO (amount in kobo)."
    );
  }
  return Math.round(amount);
}

function currency() {
  return (process.env.PAYSTACK_CURRENCY?.trim() || "NGN").toUpperCase();
}

async function paystackRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      "Content-Type": "application/json",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const json = (await res.json()) as PaystackApiResult<T>;
  if (!res.ok || !json.status) {
    throw new Error(json.message || `Paystack request failed (${res.status})`);
  }
  return json.data;
}

async function getAccountPaystackFields(userId: string) {
  const account = await ensureBillingAccount(userId);
  const { data, error } = await supabaseAdmin
    .from("billing_accounts")
    .select("paystack_customer_code, paystack_subscription_code, paystack_email_token")
    .eq("user_id", userId)
    .maybeSingle();

  if (error && !/column|does not exist/i.test(error.message)) {
    throw new Error(error.message);
  }

  const row = data as PaystackCustomerFields | null;
  return {
    account,
    customerCode: row?.paystack_customer_code ?? null,
    subscriptionCode: row?.paystack_subscription_code ?? null,
    emailToken: row?.paystack_email_token ?? null,
  };
}

async function savePaystackFields(
  userId: string,
  patch: Partial<PaystackCustomerFields> & { renews_on?: string | null }
) {
  const { error } = await supabaseAdmin
    .from("billing_accounts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  if (error) {
    console.warn("[paystack] savePaystackFields:", error.message);
  }
}

async function disableSubscription(
  subscriptionCode: string,
  emailToken: string | null
): Promise<boolean> {
  if (!emailToken) {
    console.warn("[paystack] Cannot disable subscription without email_token:", subscriptionCode);
    return false;
  }
  try {
    await paystackRequest("/subscription/disable", {
      method: "POST",
      body: { code: subscriptionCode, token: emailToken },
    });
    return true;
  } catch (err) {
    console.warn("[paystack] disableSubscription:", err instanceof Error ? err.message : err);
    return false;
  }
}

async function subscriptionNextPayment(subscriptionCode: string): Promise<string | null> {
  try {
    const sub = await paystackRequest<{ next_payment_date?: string | null }>(
      `/subscription/${encodeURIComponent(subscriptionCode)}`
    );
    return sub.next_payment_date ? new Date(sub.next_payment_date).toISOString() : null;
  } catch (err) {
    console.warn("[paystack] subscriptionNextPayment:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Drops the subscription and forgets it. Only for a subscription superseded by a new
 * active one — Paystack has no mid-period termination, so this just stops renewals.
 */
export async function cancelSubscriptionImmediately(
  userId: string,
  options?: { except?: string | null }
): Promise<boolean> {
  if (!isPaystackConfigured()) return false;

  const { subscriptionCode, emailToken } = await getAccountPaystackFields(userId);
  if (!subscriptionCode) return false;
  if (options?.except && subscriptionCode === options.except) return false;

  await disableSubscription(subscriptionCode, emailToken);
  await savePaystackFields(userId, {
    paystack_subscription_code: null,
    paystack_email_token: null,
  });
  return true;
}

/**
 * Stops the renewal. The period already paid for is untouched, so the caller keeps the
 * plan active until `periodEnd`. Paystack has no "cancel later", so the subscription is
 * disabled now and the stored codes are dropped with it.
 */
export async function cancelSubscriptionAtPeriodEnd(
  userId: string
): Promise<{ scheduled: boolean; periodEnd: string | null }> {
  if (!isPaystackConfigured()) return { scheduled: false, periodEnd: null };

  const { account, subscriptionCode, emailToken } = await getAccountPaystackFields(userId);
  if (!subscriptionCode) return { scheduled: false, periodEnd: null };

  const periodEnd = (await subscriptionNextPayment(subscriptionCode)) ?? account.renews_on;
  const disabled = await disableSubscription(subscriptionCode, emailToken);
  if (!disabled) {
    throw new Error("Could not cancel the Paystack subscription. Please contact support.");
  }

  await savePaystackFields(userId, {
    paystack_subscription_code: null,
    paystack_email_token: null,
  });
  return { scheduled: true, periodEnd };
}

export async function createPlanCheckoutSession(input: {
  userId: string;
  email: string;
  planId: "pro" | "enterprise";
}): Promise<{ url: string }> {
  const planCode = planCodeForTier(input.planId);

  const plan = await paystackRequest<{ amount: number; currency?: string; plan_code: string }>(
    `/plan/${encodeURIComponent(planCode)}`
  );

  const data = await paystackRequest<{ authorization_url: string; reference: string }>(
    "/transaction/initialize",
    {
      method: "POST",
      body: {
        email: input.email,
        amount: plan.amount,
        plan: planCode,
        currency: (plan.currency || currency()).toUpperCase(),
        callback_url: appUrl("/dashboard/billing/plans?checkout=success"),
        metadata: {
          userId: input.userId,
          planId: input.planId,
          purpose: "plan",
          cancel_action: appUrl("/dashboard/billing/plans?checkout=cancel"),
        },
      },
    }
  );

  if (!data.authorization_url) throw new Error("Could not create Paystack checkout session");
  return { url: data.authorization_url };
}

export async function createCreditsAddonCheckoutSession(input: {
  userId: string;
  email: string;
}): Promise<{ url: string }> {
  const amount = creditsAddonAmountKobo();
  const data = await paystackRequest<{ authorization_url: string; reference: string }>(
    "/transaction/initialize",
    {
      method: "POST",
      body: {
        email: input.email,
        amount,
        currency: currency(),
        callback_url: appUrl("/dashboard/billing?addon=success"),
        metadata: {
          userId: input.userId,
          purpose: "credits_addon",
          cancel_action: appUrl("/dashboard/billing?addon=cancel"),
        },
      },
    }
  );

  if (!data.authorization_url) throw new Error("Could not create Paystack checkout session");
  return { url: data.authorization_url };
}

export async function createBillingPortalSession(input: {
  userId: string;
  email: string;
}): Promise<{ url: string }> {
  const { subscriptionCode } = await getAccountPaystackFields(input.userId);
  if (!subscriptionCode) {
    throw new Error("No active Paystack subscription to manage. Subscribe to a plan first.");
  }

  const data = await paystackRequest<{ link: string }>(
    `/subscription/${encodeURIComponent(subscriptionCode)}/manage/link`
  );

  if (!data.link) throw new Error("Could not create Paystack manage link");
  return { url: data.link };
}

/**
 * Points the account at `subscriptionCode`, disabling whatever it pointed at before.
 * A plan switch creates a second subscription, and only one may stay live.
 */
async function adoptSubscription(
  userId: string,
  subscriptionCode: string,
  emailToken: string | null
) {
  const { subscriptionCode: previous, emailToken: previousToken } =
    await getAccountPaystackFields(userId);

  await savePaystackFields(userId, {
    paystack_subscription_code: subscriptionCode,
    paystack_email_token: emailToken,
  });

  if (previous && previous !== subscriptionCode) {
    await disableSubscription(previous, previousToken);
  }
}

async function applyPaidPlan(userId: string, planId: "pro" | "enterprise", renewsOn: string | null) {
  const before = await ensureBillingAccount(userId);

  await changePlan(userId, planId);
  await setCancelAtPeriodEnd(userId, false);
  await setPendingPlanChange(userId, null, null);
  if (renewsOn) {
    await savePaystackFields(userId, { renews_on: renewsOn });
  }
  await cancelOtherProviderSubscription(userId, "paystack");

  // Charges recur, so only announce a plan that actually moved.
  if (before.plan_id === planId) return;

  const tierName = getTierCatalog()[planId as PlanTierId]?.name ?? "your plan";
  const renewsLabel = formatPlanDate(renewsOn);
  await createNotification(userId, {
    category: "billing",
    title: "Subscription updated",
    description: renewsLabel
      ? `Your Convert Tide plan is now ${tierName}, effective immediately. Next charge ${renewsLabel}.`
      : `Your Convert Tide plan is now ${tierName}, effective immediately.`,
    actionLabel: "View Billing",
    actionHref: "/dashboard/billing",
    actionTone: "primary",
  });
}

async function grantCreditsAddon(userId: string, amount = 1000) {
  const account = await ensureBillingAccount(userId);
  const { error } = await supabaseAdmin
    .from("billing_accounts")
    .update({
      credits_total: account.credits_total + amount,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (error) throw new Error(error.message);

  await createNotification(userId, {
    category: "billing",
    title: "Credits added",
    description: `${amount.toLocaleString()} AI credits were added to your account.`,
    actionLabel: "View Billing",
    actionHref: "/dashboard/billing",
    actionTone: "primary",
  });
}

async function recordInvoice(input: {
  userId: string;
  id: string;
  amountKobo: number;
  currency: string;
  description: string;
  status: "paid" | "pending" | "failed";
  paidAt?: number | string | null;
}) {
  const amount = (input.amountKobo / 100).toLocaleString("en-NG", {
    style: "currency",
    currency: input.currency.toUpperCase(),
  });

  const invoiceDate =
    typeof input.paidAt === "number"
      ? new Date(input.paidAt * 1000).toISOString()
      : typeof input.paidAt === "string"
        ? new Date(input.paidAt).toISOString()
        : new Date().toISOString();

  await supabaseAdmin.from("billing_invoices").upsert(
    {
      id: input.id,
      user_id: input.userId,
      invoice_date: invoiceDate,
      description: input.description,
      amount,
      status: input.status,
    },
    { onConflict: "id" }
  );
}

function readMetadata(meta: unknown): Record<string, string> {
  if (!meta || typeof meta !== "object") return {};
  const record = meta as Record<string, unknown>;
  // Paystack sometimes nests custom fields under metadata.custom_fields
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
    }
  }
  return out;
}

type VerifiedTransaction = {
  reference: string;
  status: string;
  amount: number;
  currency: string;
  paid_at?: string | null;
  customer?: { customer_code?: string; email?: string };
  plan?: { plan_code?: string; name?: string } | string | null;
  authorization?: { last4?: string; brand?: string; exp_month?: string | number; exp_year?: string | number };
  metadata?: unknown;
};

async function applySuccessfulCharge(tx: VerifiedTransaction) {
  const meta = readMetadata(tx.metadata);
  const userId = meta.userId;
  if (!userId) return;

  const customerCode = tx.customer?.customer_code ?? null;
  if (customerCode) {
    await savePaystackFields(userId, { paystack_customer_code: customerCode });
  }

  if (tx.authorization?.last4) {
    const brand = String(tx.authorization.brand || "card").toLowerCase();
    const expMonth = String(tx.authorization.exp_month ?? "").padStart(2, "0");
    const expYear = String(tx.authorization.exp_year ?? "").slice(-2);
    await supabaseAdmin
      .from("billing_accounts")
      .update({
        payment_brand: brand.includes("master") ? "mastercard" : brand.includes("visa") ? "visa" : brand,
        payment_last4: tx.authorization.last4,
        payment_expiry: expMonth && expYear ? `${expMonth}/${expYear}` : null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
  }

  if (meta.purpose === "credits_addon") {
    await grantCreditsAddon(userId);
    await recordInvoice({
      userId,
      id: `paystack_${tx.reference}`,
      amountKobo: tx.amount,
      currency: tx.currency || currency(),
      description: "AI credits add-on",
      status: "paid",
      paidAt: tx.paid_at,
    });
    return;
  }

  const planCode = typeof tx.plan === "string" ? tx.plan : tx.plan?.plan_code;
  const planId =
    planIdFromPlanCode(planCode) ??
    (meta.planId === "pro" || meta.planId === "enterprise" || meta.planId === "scale"
      ? meta.planId === "scale"
        ? "enterprise"
        : meta.planId
      : null);

  if (planId === "pro" || planId === "enterprise") {
    const renews = new Date();
    renews.setMonth(renews.getMonth() + 1);
    await applyPaidPlan(userId, planId, renews.toISOString());
  }

  await recordInvoice({
    userId,
    id: `paystack_${tx.reference}`,
    amountKobo: tx.amount,
    currency: tx.currency || currency(),
    description:
      (typeof tx.plan === "object" && tx.plan?.name) ||
      (planId ? `${getTierCatalog()[planId].name} subscription` : "Convert Tide subscription"),
    status: "paid",
    paidAt: tx.paid_at,
  });
}

export async function verifyPaystackReference(reference: string) {
  const tx = await paystackRequest<VerifiedTransaction>(
    `/transaction/verify/${encodeURIComponent(reference)}`
  );

  if (tx.status === "success") {
    await applySuccessfulCharge(tx);
  }

  return { status: tx.status, reference: tx.reference };
}

type PaystackWebhookEvent = {
  event: string;
  data: Record<string, unknown>;
};

export async function handlePaystackWebhook(rawBody: Buffer, signature: string | undefined) {
  if (!signature) throw new Error("Missing x-paystack-signature header");

  const hash = crypto.createHmac("sha512", secretKey()).update(rawBody).digest("hex");
  if (hash !== signature) {
    throw new Error("Invalid Paystack webhook signature");
  }

  const payload = JSON.parse(rawBody.toString("utf8")) as PaystackWebhookEvent;
  const event = payload.event;
  const data = payload.data || {};

  switch (event) {
    case "charge.success": {
      await applySuccessfulCharge(data as unknown as VerifiedTransaction);
      break;
    }
    case "subscription.create":
    case "subscription.not_renew":
    case "subscription.disable": {
      const customer = data.customer as { customer_code?: string } | undefined;
      const subscriptionCode = typeof data.subscription_code === "string" ? data.subscription_code : null;
      const emailToken = typeof data.email_token === "string" ? data.email_token : null;
      const plan = data.plan as { plan_code?: string } | undefined;
      const customerCode = customer?.customer_code;

      let userId: string | null = null;
      if (customerCode) {
        const { data: account } = await supabaseAdmin
          .from("billing_accounts")
          .select("user_id")
          .eq("paystack_customer_code", customerCode)
          .maybeSingle();
        userId = (account as { user_id?: string } | null)?.user_id ?? null;
      }

      // Fallback: metadata on subscription create sometimes includes custom fields
      if (!userId) {
        const meta = readMetadata(data.metadata);
        if (meta.userId) userId = meta.userId;
      }

      if (!userId) break;

      if (event === "subscription.disable") {
        const { subscriptionCode: current } = await getAccountPaystackFields(userId);
        // A subscription we replaced is no longer the account's source of truth.
        if (current && subscriptionCode && current !== subscriptionCode) break;
        if (current) {
          await savePaystackFields(userId, {
            paystack_subscription_code: null,
            paystack_email_token: null,
          });
        }
        // Moved to Stripe: that subscription now governs the plan.
        if (await hasActiveProviderSubscription(userId)) break;

        const account = await ensureBillingAccount(userId);
        if (account.plan_id === "free") break;
        // Already recorded — this event is the echo of our own cancel request.
        if (account.cancel_at_period_end) break;

        const paidUntil =
          typeof data.next_payment_date === "string"
            ? new Date(data.next_payment_date).toISOString()
            : account.renews_on;

        // Paystack cannot refund a part-used month, so the plan runs to the end of the
        // period already paid for; `ensureBillingAccount` drops it to Free after that.
        if (paidUntil && new Date(paidUntil).getTime() > Date.now()) {
          await setCancelAtPeriodEnd(userId, true, paidUntil);
          await createNotification(userId, {
            category: "billing",
            title: "Renewal cancelled",
            description: `Your ${account.plan_name} plan won't renew. You keep full access until ${new Date(paidUntil).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.`,
            actionLabel: "View Billing",
            actionHref: "/dashboard/billing",
            actionTone: "warning",
          });
          break;
        }

        await changePlan(userId, "free");
        await setCancelAtPeriodEnd(userId, false);
        await createNotification(userId, {
          category: "billing",
          title: "Subscription cancelled",
          description: "Your paid subscription ended. You're back on the Free plan.",
          actionLabel: "View Billing",
          actionHref: "/dashboard/billing",
          actionTone: "primary",
        });
        break;
      }

      const planId = planIdFromPlanCode(plan?.plan_code);
      const nextPayment =
        typeof data.next_payment_date === "string" ? new Date(data.next_payment_date).toISOString() : null;

      await savePaystackFields(userId, {
        paystack_customer_code: customerCode ?? undefined,
        renews_on: nextPayment,
      });
      if (subscriptionCode) {
        await adoptSubscription(userId, subscriptionCode, emailToken);
      }

      if (planId && event === "subscription.create") {
        await applyPaidPlan(userId, planId, nextPayment);
      }
      break;
    }
    case "invoice.create":
    case "invoice.update": {
      const customer = data.customer as { customer_code?: string } | undefined;
      const customerCode = customer?.customer_code;
      if (!customerCode) break;

      const { data: account } = await supabaseAdmin
        .from("billing_accounts")
        .select("user_id")
        .eq("paystack_customer_code", customerCode)
        .maybeSingle();
      const userId = (account as { user_id?: string } | null)?.user_id;
      if (!userId) break;

      const invoiceCode = typeof data.invoice_code === "string" ? data.invoice_code : `paystack_inv_${Date.now()}`;
      const amount =
        typeof data.amount === "number"
          ? data.amount
          : typeof data.requested_amount === "number"
            ? data.requested_amount
            : 0;
      const paid = data.status === "success" || data.paid === true;

      await recordInvoice({
        userId,
        id: invoiceCode,
        amountKobo: amount,
        currency: typeof data.currency === "string" ? data.currency : currency(),
        description: "Convert Tide subscription invoice",
        status: paid ? "paid" : data.status === "failed" ? "failed" : "pending",
        paidAt: typeof data.paid_at === "string" ? data.paid_at : null,
      });
      break;
    }
    default:
      break;
  }

  return { received: true, type: event };
}

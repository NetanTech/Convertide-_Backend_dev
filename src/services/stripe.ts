import Stripe from "stripe";
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

type StripeCustomerFields = {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

let stripeClient: Stripe | null = null;

export function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY in the backend .env.");
  }
  if (!stripeClient) {
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

function priceIdForTier(planId: "pro" | "enterprise"): string {
  const map = {
    pro: process.env.STRIPE_PRICE_PRO?.trim() || "",
    enterprise:
      process.env.STRIPE_PRICE_ENTERPRISE?.trim() ||
      process.env.STRIPE_PRICE_SCALE?.trim() ||
      "",
  };
  const priceId = map[planId];
  if (!priceId) {
    throw new Error(
      `Missing Stripe price for ${planId}. Set STRIPE_PRICE_ENTERPRISE (or STRIPE_PRICE_SCALE) / STRIPE_PRICE_PRO.`
    );
  }
  return priceId;
}

function planIdFromPriceId(priceId: string | null | undefined): "pro" | "enterprise" | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_PRO?.trim()) return "pro";
  if (
    priceId === process.env.STRIPE_PRICE_ENTERPRISE?.trim() ||
    priceId === process.env.STRIPE_PRICE_SCALE?.trim()
  ) {
    return "enterprise";
  }
  return null;
}

function normalizePaidPlanId(
  planId: string | null | undefined
): "pro" | "enterprise" | null {
  if (planId === "pro") return "pro";
  if (planId === "enterprise" || planId === "scale") return "enterprise";
  return null;
}

function creditsAddonPriceId(): string | null {
  return process.env.STRIPE_CREDITS_ADDON_PRICE_ID?.trim() || null;
}

function creditsAddonAmountCents(): number {
  const raw = process.env.STRIPE_CREDITS_ADDON_AMOUNT_CENTS?.trim();
  const amount = raw ? Number(raw) : 0;
  if (!Number.isFinite(amount) || amount < 50) {
    throw new Error(
      "Credit add-ons are not configured. Set STRIPE_CREDITS_ADDON_PRICE_ID or STRIPE_CREDITS_ADDON_AMOUNT_CENTS."
    );
  }
  return Math.round(amount);
}

async function getAccountStripeFields(userId: string) {
  const account = await ensureBillingAccount(userId);
  const { data, error } = await supabaseAdmin
    .from("billing_accounts")
    .select("stripe_customer_id, stripe_subscription_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error && !/column|does not exist/i.test(error.message)) {
    throw new Error(error.message);
  }

  const row = data as StripeCustomerFields | null;
  return {
    account,
    customerId: row?.stripe_customer_id ?? null,
    subscriptionId: row?.stripe_subscription_id ?? null,
  };
}

async function saveStripeFields(
  userId: string,
  patch: Partial<StripeCustomerFields> & { renews_on?: string | null }
) {
  const { error } = await supabaseAdmin
    .from("billing_accounts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  if (error) {
    console.warn("[stripe] saveStripeFields:", error.message);
  }
}

async function ensureStripeCustomer(userId: string, email: string): Promise<string> {
  const { customerId } = await getAccountStripeFields(userId);
  if (customerId) return customerId;

  const customer = await stripe().customers.create({
    email,
    metadata: { userId },
  });
  await saveStripeFields(userId, { stripe_customer_id: customer.id });
  return customer.id;
}

/**
 * Terminates the subscription now and forgets it. Only for a subscription that has
 * been superseded by a new active one — it ends access immediately.
 */
export async function cancelSubscriptionImmediately(
  userId: string,
  options?: { except?: string | null }
): Promise<boolean> {
  if (!isStripeConfigured()) return false;

  const { subscriptionId } = await getAccountStripeFields(userId);
  if (!subscriptionId) return false;
  if (options?.except && subscriptionId === options.except) return false;

  try {
    await stripe().subscriptions.cancel(subscriptionId);
  } catch (err) {
    console.warn("[stripe] cancelSubscriptionImmediately:", err instanceof Error ? err.message : err);
  }
  await saveStripeFields(userId, { stripe_subscription_id: null });
  return true;
}

/**
 * Stops the renewal but leaves the subscription live until the paid period ends.
 * The stored id is kept so the period-end `subscription.deleted` event is recognised.
 */
export async function cancelSubscriptionAtPeriodEnd(
  userId: string
): Promise<{ scheduled: boolean; periodEnd: string | null }> {
  if (!isStripeConfigured()) return { scheduled: false, periodEnd: null };

  const { subscriptionId } = await getAccountStripeFields(userId);
  if (!subscriptionId) return { scheduled: false, periodEnd: null };

  const subscription = await stripe().subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });

  const periodEnd = subscriptionPeriodEnd(subscription);
  return {
    scheduled: true,
    periodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
  };
}

export type InPlacePlanChange = {
  /** "immediate" bills the prorated difference now; "period_end" waits. */
  effective: "immediate" | "period_end";
  effectiveAt: string | null;
  planId: "pro" | "enterprise";
};

/**
 * Rewrites the phases of a subscription's schedule so the new price starts when the
 * period the user already paid for ends.
 */
async function scheduleTierChange(
  subscription: Stripe.Subscription,
  item: Stripe.SubscriptionItem,
  newPriceId: string
) {
  const existing =
    typeof subscription.schedule === "string" ? subscription.schedule : subscription.schedule?.id;
  const scheduleId =
    existing ??
    (await stripe().subscriptionSchedules.create({ from_subscription: subscription.id })).id;

  const schedule = await stripe().subscriptionSchedules.retrieve(scheduleId);
  const currentPhase = schedule.phases[schedule.phases.length - 1];
  const currentPriceId = typeof item.price === "string" ? item.price : item.price.id;

  await stripe().subscriptionSchedules.update(scheduleId, {
    end_behavior: "release",
    phases: [
      {
        items: [{ price: currentPriceId, quantity: item.quantity ?? 1 }],
        start_date: currentPhase.start_date,
        end_date: currentPhase.end_date,
        proration_behavior: "none",
      },
      {
        items: [{ price: newPriceId, quantity: 1 }],
        proration_behavior: "none",
      },
    ],
  });
}

/**
 * Moves an existing subscription to another tier without a second checkout, which would
 * charge twice for the period already paid for.
 *
 * Upgrades apply at once and invoice only the prorated difference. Downgrades start at
 * the end of the current period, so paid-for access is never cut short.
 *
 * Returns null when there's no subscription to update, leaving the caller to send the
 * user through checkout instead.
 */
export async function changePlanInPlace(
  userId: string,
  planId: "pro" | "enterprise"
): Promise<InPlacePlanChange | null> {
  if (!isStripeConfigured()) return null;

  const { subscriptionId } = await getAccountStripeFields(userId);
  if (!subscriptionId) return null;

  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe().subscriptions.retrieve(subscriptionId);
  } catch (err) {
    console.warn("[stripe] changePlanInPlace retrieve:", err instanceof Error ? err.message : err);
    return null;
  }

  if (subscription.status !== "active" && subscription.status !== "trialing") return null;

  const item = subscription.items.data[0];
  if (!item) return null;

  const newPriceId = priceIdForTier(planId);
  const currentPriceId = typeof item.price === "string" ? item.price : item.price?.id;
  const currentPlanId = planIdFromPriceId(currentPriceId);

  const rank = { pro: 1, enterprise: 2 } as const;
  const isUpgrade = !currentPlanId || rank[planId] > rank[currentPlanId];
  const periodEnd = subscriptionPeriodEnd(subscription);
  const periodEndIso = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;

  if (!isUpgrade) {
    await scheduleTierChange(subscription, item, newPriceId);
    await setPendingPlanChange(userId, planId, periodEndIso);
    await setCancelAtPeriodEnd(userId, false);

    const tierName = getTierCatalog()[planId as PlanTierId]?.name ?? "your new plan";
    const currentName = getTierCatalog()[(currentPlanId ?? "pro") as PlanTierId]?.name ?? "your plan";
    const startsOn = formatPlanDate(periodEndIso);
    await createNotification(userId, {
      category: "billing",
      title: "Plan change scheduled",
      description: startsOn
        ? `You move to ${tierName} on ${startsOn}. You keep ${currentName} access until then, and you won't be charged twice.`
        : `You move to ${tierName} at the end of this billing period. You keep ${currentName} access until then.`,
      actionLabel: "View Billing",
      actionHref: "/dashboard/billing",
      actionTone: "primary",
    });

    return { effective: "period_end", effectiveAt: periodEndIso, planId };
  }

  // An upgrade supersedes any scheduled downgrade; a scheduled subscription rejects
  // direct item updates, so let it go first.
  const scheduleId =
    typeof subscription.schedule === "string" ? subscription.schedule : subscription.schedule?.id;
  if (scheduleId) {
    try {
      await stripe().subscriptionSchedules.release(scheduleId);
    } catch (err) {
      console.warn("[stripe] release schedule:", err instanceof Error ? err.message : err);
    }
  }

  const updated = await stripe().subscriptions.update(subscriptionId, {
    items: [{ id: item.id, price: newPriceId }],
    proration_behavior: "always_invoice",
    cancel_at_period_end: false,
  });

  await setPendingPlanChange(userId, null, null);
  const updatedPeriodEnd = subscriptionPeriodEnd(updated);
  await applyPaidPlan(
    userId,
    planId,
    updatedPeriodEnd ? new Date(updatedPeriodEnd * 1000).toISOString() : periodEndIso
  );

  return { effective: "immediate", effectiveAt: new Date().toISOString(), planId };
}

export async function createPlanCheckoutSession(input: {
  userId: string;
  email: string;
  planId: "pro" | "enterprise";
}): Promise<{ url: string }> {
  const priceId = priceIdForTier(input.planId);
  const customerId = await ensureStripeCustomer(input.userId, input.email);

  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: appUrl("/dashboard/billing/plans?checkout=success&session_id={CHECKOUT_SESSION_ID}"),
    cancel_url: appUrl("/dashboard/billing/plans?checkout=cancel"),
    client_reference_id: input.userId,
    metadata: {
      userId: input.userId,
      planId: input.planId,
      purpose: "plan",
    },
    subscription_data: {
      metadata: {
        userId: input.userId,
        planId: input.planId,
        purpose: "plan",
      },
    },
  });

  if (!session.url) throw new Error("Could not create Stripe checkout session");
  return { url: session.url };
}

export async function createCreditsAddonCheckoutSession(input: {
  userId: string;
  email: string;
}): Promise<{ url: string }> {
  const customerId = await ensureStripeCustomer(input.userId, input.email);
  const priceId = creditsAddonPriceId();

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = priceId
    ? [{ price: priceId, quantity: 1 }]
    : [
        {
          quantity: 1,
          price_data: {
            currency: (process.env.STRIPE_CURRENCY?.trim() || "usd").toLowerCase(),
            unit_amount: creditsAddonAmountCents(),
            product_data: {
              name: "AI credits add-on",
              description: "One-time Convert Tide credit pack",
            },
          },
        },
      ];

  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: lineItems,
    success_url: appUrl("/dashboard/billing?addon=success&session_id={CHECKOUT_SESSION_ID}"),
    cancel_url: appUrl("/dashboard/billing?addon=cancel"),
    client_reference_id: input.userId,
    metadata: {
      userId: input.userId,
      purpose: "credits_addon",
    },
  });

  if (!session.url) throw new Error("Could not create Stripe checkout session");
  return { url: session.url };
}

export async function createBillingPortalSession(input: {
  userId: string;
  email: string;
}): Promise<{ url: string }> {
  const customerId = await ensureStripeCustomer(input.userId, input.email);
  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: appUrl("/dashboard/billing"),
  });
  if (!session.url) throw new Error("Could not create Stripe billing portal session");
  return { url: session.url };
}

/**
 * Points the account at `subscriptionId`, terminating whatever it pointed at before.
 * A plan switch creates a second subscription, and only one may stay live.
 */
async function adoptSubscription(userId: string, subscriptionId: string) {
  const { subscriptionId: previous } = await getAccountStripeFields(userId);
  await saveStripeFields(userId, { stripe_subscription_id: subscriptionId });

  if (previous && previous !== subscriptionId) {
    try {
      await stripe().subscriptions.cancel(previous);
    } catch (err) {
      console.warn("[stripe] cancel superseded subscription:", err instanceof Error ? err.message : err);
    }
  }
}

async function applyPaidPlan(userId: string, planId: "pro" | "enterprise", renewsOn: string | null) {
  const before = await ensureBillingAccount(userId);

  await changePlan(userId, planId);
  await setCancelAtPeriodEnd(userId, false);
  await setPendingPlanChange(userId, null, null);
  if (renewsOn) {
    await saveStripeFields(userId, { renews_on: renewsOn });
  }
  await cancelOtherProviderSubscription(userId, "stripe");

  // Stripe emits `subscription.updated` for renewals and cancellations too, so only
  // announce a plan that actually moved.
  if (before.plan_id === planId) return;

  const tierName = getTierCatalog()[planId as PlanTierId]?.name ?? "your plan";
  const renewsLabel = formatPlanDate(renewsOn);
  await createNotification(userId, {
    category: "billing",
    title: "Subscription updated",
    description: renewsLabel
      ? `Your Convert Tide plan is now ${tierName}, effective immediately. Next renewal ${renewsLabel}.`
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
  amountCents: number;
  currency: string;
  description: string;
  status: "paid" | "pending" | "failed";
  paidAt?: number | string | null;
}) {
  const amount = (input.amountCents / 100).toLocaleString("en-US", {
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

async function findUserIdByCustomer(customerId: string | null | undefined): Promise<string | null> {
  if (!customerId) return null;
  const { data } = await supabaseAdmin
    .from("billing_accounts")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return (data as { user_id?: string } | null)?.user_id ?? null;
}

async function syncPaymentMethodFromSubscription(userId: string, subscription: Stripe.Subscription) {
  const paymentMethodId =
    typeof subscription.default_payment_method === "string"
      ? subscription.default_payment_method
      : subscription.default_payment_method?.id;

  if (!paymentMethodId) return;

  try {
    const pm = await stripe().paymentMethods.retrieve(paymentMethodId);
    if (pm.card) {
      const brand = (pm.card.brand || "card").toLowerCase();
      const expMonth = String(pm.card.exp_month ?? "").padStart(2, "0");
      const expYear = String(pm.card.exp_year ?? "").slice(-2);
      await supabaseAdmin
        .from("billing_accounts")
        .update({
          payment_brand: brand.includes("master") ? "mastercard" : brand.includes("visa") ? "visa" : brand,
          payment_last4: pm.card.last4,
          payment_expiry: expMonth && expYear ? `${expMonth}/${expYear}` : null,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    }
  } catch (err) {
    console.warn("[stripe] syncPaymentMethod:", err instanceof Error ? err.message : err);
  }
}

function subscriptionPeriodEnd(subscription: Stripe.Subscription): number | null {
  const fromItem = subscription.items?.data?.[0]?.current_period_end;
  if (typeof fromItem === "number") return fromItem;
  const legacy = (subscription as unknown as { current_period_end?: number }).current_period_end;
  return typeof legacy === "number" ? legacy : null;
}

async function applyCheckoutSession(session: Stripe.Checkout.Session) {
  const userId =
    session.metadata?.userId ||
    session.client_reference_id ||
    (await findUserIdByCustomer(typeof session.customer === "string" ? session.customer : session.customer?.id));

  if (!userId) return;

  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (customerId) {
    await saveStripeFields(userId, { stripe_customer_id: customerId });
  }

  if (session.metadata?.purpose === "credits_addon" || session.mode === "payment") {
    if (session.metadata?.purpose === "credits_addon") {
      await grantCreditsAddon(userId);
      await recordInvoice({
        userId,
        id: `stripe_${session.id}`,
        amountCents: session.amount_total ?? 0,
        currency: session.currency || "usd",
        description: "AI credits add-on",
        status: "paid",
      });
    }
    return;
  }

  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id;

  let planId: "pro" | "enterprise" | null =
    normalizePaidPlanId(session.metadata?.planId);

  let renewsOn: string | null = null;

  if (subscriptionId) {
    const subscription = await stripe().subscriptions.retrieve(subscriptionId);
    await adoptSubscription(userId, subscription.id);
    await syncPaymentMethodFromSubscription(userId, subscription);

    const priceId = subscription.items.data[0]?.price?.id;
    planId = planIdFromPriceId(priceId) ?? planId;
    const periodEnd = subscriptionPeriodEnd(subscription);
    renewsOn = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
  }

  if (planId === "pro" || planId === "enterprise") {
    await applyPaidPlan(userId, planId, renewsOn);
  }

  await recordInvoice({
    userId,
    id: `stripe_${session.id}`,
    amountCents: session.amount_total ?? 0,
    currency: session.currency || "usd",
    description: planId
      ? `${getTierCatalog()[planId].name} subscription`
      : "Convert Tide subscription",
    status: "paid",
  });
}

export async function verifyStripeCheckoutSession(sessionId: string) {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  if (session.status === "complete" || session.payment_status === "paid") {
    await applyCheckoutSession(session);
  }
  return { status: session.status || session.payment_status || "unknown", reference: session.id };
}

export async function handleStripeWebhook(rawBody: Buffer, signature: string | undefined) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  if (!signature) throw new Error("Missing stripe-signature header");

  const event = stripe().webhooks.constructEvent(rawBody, signature, secret);

  switch (event.type) {
    case "checkout.session.completed": {
      await applyCheckoutSession(event.data.object as Stripe.Checkout.Session);
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const subscription = event.data.object as Stripe.Subscription;
      const userId =
        subscription.metadata?.userId ||
        (await findUserIdByCustomer(
          typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id
        ));
      if (!userId) break;

      const customerId =
        typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
      const periodEnd = subscriptionPeriodEnd(subscription);
      await saveStripeFields(userId, {
        stripe_customer_id: customerId ?? undefined,
        renews_on: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      });
      await adoptSubscription(userId, subscription.id);
      await syncPaymentMethodFromSubscription(userId, subscription);

      const priceId = subscription.items.data[0]?.price?.id;
      const planId =
        planIdFromPriceId(priceId) ?? normalizePaidPlanId(subscription.metadata?.planId);

      if (
        planId &&
        (subscription.status === "active" || subscription.status === "trialing")
      ) {
        await applyPaidPlan(
          userId,
          planId,
          periodEnd ? new Date(periodEnd * 1000).toISOString() : null
        );
        // Stripe owns this flag once a subscription exists; mirror it so the dashboard
        // can say "access until" instead of "renews on".
        await setCancelAtPeriodEnd(userId, subscription.cancel_at_period_end === true);
      }
      break;
    }
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const userId =
        subscription.metadata?.userId ||
        (await findUserIdByCustomer(
          typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id
        ));
      if (!userId) break;

      const { subscriptionId: current } = await getAccountStripeFields(userId);
      // A subscription we replaced (plan switch, or a move to Paystack) is no longer
      // the account's source of truth, so its ending must not touch the plan.
      if (current && current !== subscription.id) break;
      if (current) {
        await saveStripeFields(userId, { stripe_subscription_id: null });
      }
      if (await hasActiveProviderSubscription(userId)) break;

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
    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      const userId = await findUserIdByCustomer(customerId);
      if (!userId) break;

      await recordInvoice({
        userId,
        id: invoice.id || `stripe_inv_${Date.now()}`,
        amountCents: invoice.amount_paid || invoice.amount_due || 0,
        currency: invoice.currency || "usd",
        description: invoice.description || "Convert Tide subscription invoice",
        status: event.type === "invoice.paid" ? "paid" : "failed",
        paidAt: invoice.status_transitions?.paid_at ?? null,
      });
      break;
    }
    default:
      break;
  }

  return { received: true, type: event.type };
}

import Stripe from "stripe";
import { supabaseAdmin } from "../config/supabase";
import { changePlan, ensureBillingAccount, getTierCatalog, type PlanTierId } from "./billing";
import { createNotification } from "./notifications";
import { appUrl } from "./mailer";

let stripeClient: Stripe | null = null;

export function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY in the backend .env.");
  }
  if (!stripeClient) {
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

function priceIdForPlan(planId: "pro" | "scale"): string {
  const map = {
    pro: process.env.STRIPE_PRICE_PRO?.trim() || "",
    scale: process.env.STRIPE_PRICE_SCALE?.trim() || "",
  };
  const priceId = map[planId];
  if (!priceId) {
    throw new Error(`Missing Stripe price id for ${planId}. Set STRIPE_PRICE_${planId.toUpperCase()}.`);
  }
  return priceId;
}

function planIdFromPrice(priceId: string | null | undefined): "pro" | "scale" | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_PRO?.trim()) return "pro";
  if (priceId === process.env.STRIPE_PRICE_SCALE?.trim()) return "scale";
  return null;
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

  return {
    account,
    stripeCustomerId: (data as { stripe_customer_id?: string | null } | null)?.stripe_customer_id ?? null,
    stripeSubscriptionId:
      (data as { stripe_subscription_id?: string | null } | null)?.stripe_subscription_id ?? null,
  };
}

async function saveStripeIds(
  userId: string,
  patch: { stripe_customer_id?: string | null; stripe_subscription_id?: string | null }
) {
  const { error } = await supabaseAdmin
    .from("billing_accounts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  if (error) {
    // Column may not exist until migration 011 is applied.
    console.warn("[stripe] saveStripeIds:", error.message);
  }
}

export async function ensureStripeCustomer(userId: string, email: string): Promise<string> {
  const stripe = getStripe();
  const { stripeCustomerId } = await getAccountStripeFields(userId);

  if (stripeCustomerId) {
    return stripeCustomerId;
  }

  const customer = await stripe.customers.create({
    email,
    metadata: { userId },
  });

  await saveStripeIds(userId, { stripe_customer_id: customer.id });
  return customer.id;
}

export async function createPlanCheckoutSession(input: {
  userId: string;
  email: string;
  planId: "pro" | "scale";
}): Promise<{ url: string }> {
  const stripe = getStripe();
  const customerId = await ensureStripeCustomer(input.userId, input.email);
  const priceId = priceIdForPlan(input.planId);
  const { stripeSubscriptionId } = await getAccountStripeFields(input.userId);

  // Existing subscriber: send them to the portal to switch plans instead.
  if (stripeSubscriptionId) {
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: appUrl("/dashboard/billing/plans"),
    });
    if (!portal.url) throw new Error("Could not create billing portal session");
    return { url: portal.url };
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: appUrl("/dashboard/billing/plans?checkout=success"),
    cancel_url: appUrl("/dashboard/billing/plans?checkout=cancel"),
    metadata: {
      userId: input.userId,
      planId: input.planId,
      purpose: "plan",
    },
    subscription_data: {
      metadata: {
        userId: input.userId,
        planId: input.planId,
      },
    },
  });

  if (!session.url) throw new Error("Could not create checkout session");
  return { url: session.url };
}

export async function createCreditsAddonCheckoutSession(input: {
  userId: string;
  email: string;
}): Promise<{ url: string }> {
  const stripe = getStripe();
  const priceId = process.env.STRIPE_PRICE_CREDITS_ADDON?.trim();
  if (!priceId) {
    throw new Error("Credit add-ons are not configured. Set STRIPE_PRICE_CREDITS_ADDON.");
  }

  const customerId = await ensureStripeCustomer(input.userId, input.email);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: appUrl("/dashboard/billing?addon=success"),
    cancel_url: appUrl("/dashboard/billing?addon=cancel"),
    metadata: {
      userId: input.userId,
      purpose: "credits_addon",
    },
  });

  if (!session.url) throw new Error("Could not create checkout session");
  return { url: session.url };
}

export async function createBillingPortalSession(input: {
  userId: string;
  email: string;
}): Promise<{ url: string }> {
  const stripe = getStripe();
  const customerId = await ensureStripeCustomer(input.userId, input.email);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: appUrl("/dashboard/billing"),
  });
  if (!session.url) throw new Error("Could not create billing portal session");
  return { url: session.url };
}

async function applyPlanFromSubscription(userId: string, subscription: Stripe.Subscription) {
  const priceId = subscription.items.data[0]?.price?.id;
  const planId = planIdFromPrice(priceId) ?? (subscription.metadata.planId as "pro" | "scale" | undefined);

  if (planId === "pro" || planId === "scale") {
    await changePlan(userId, planId);
  }

  const renewsOn = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  await supabaseAdmin
    .from("billing_accounts")
    .update({
      renews_on: renewsOn,
      stripe_subscription_id: subscription.id,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  const tierName = planId ? getTierCatalog()[planId as PlanTierId]?.name : "your plan";
  await createNotification(userId, {
    category: "billing",
    title: "Subscription updated",
    description: `Your Convert Tide plan is now ${tierName}.`,
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

async function recordStripeInvoice(userId: string, invoice: Stripe.Invoice) {
  const amount = ((invoice.amount_paid ?? 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: (invoice.currency || "usd").toUpperCase(),
  });

  await supabaseAdmin.from("billing_invoices").upsert(
    {
      id: invoice.id,
      user_id: userId,
      invoice_date: new Date((invoice.created || Date.now() / 1000) * 1000).toISOString(),
      description: invoice.lines?.data?.[0]?.description || "Convert Tide subscription",
      amount,
      status: invoice.status === "paid" ? "paid" : invoice.status === "open" ? "pending" : "failed",
    },
    { onConflict: "id" }
  );
}

export async function handleStripeWebhook(rawBody: Buffer, signature: string | undefined) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  if (!signature) throw new Error("Missing Stripe-Signature header");

  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId;
      if (!userId) break;

      if (session.metadata?.purpose === "credits_addon") {
        await grantCreditsAddon(userId);
        break;
      }

      if (session.mode === "subscription" && session.subscription) {
        const subscriptionId =
          typeof session.subscription === "string" ? session.subscription : session.subscription.id;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await applyPlanFromSubscription(userId, subscription);
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = subscription.metadata?.userId;
      if (!userId) break;
      await applyPlanFromSubscription(userId, subscription);
      break;
    }
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = subscription.metadata?.userId;
      if (!userId) break;
      // Keep account on Pro entitlements but clear Stripe subscription id.
      await changePlan(userId, "pro");
      await saveStripeIds(userId, { stripe_subscription_id: null });
      await createNotification(userId, {
        category: "billing",
        title: "Subscription cancelled",
        description: "Your paid subscription ended. You're back on the Pro starter allotment.",
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
      if (!customerId) break;

      const { data: account } = await supabaseAdmin
        .from("billing_accounts")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();

      const userId = (account as { user_id?: string } | null)?.user_id;
      if (!userId) break;
      await recordStripeInvoice(userId, invoice);
      break;
    }
    default:
      break;
  }

  return { received: true, type: event.type };
}

/**
 * Create Stripe + Paystack LIVE catalog (monthly + yearly) and print Render env.
 *
 * Usage:
 *   1. Put live keys in .env.live (see template below)
 *   2. node scripts/go-live-billing.mjs
 *
 * .env.live example:
 *   STRIPE_SECRET_KEY=sk_live_...
 *   STRIPE_PUBLISHABLE_KEY=pk_live_...
 *   PAYSTACK_SECRET_KEY=sk_live_...
 *   PAYSTACK_PUBLIC_KEY=pk_live_...
 *   BACKEND_PUBLIC_URL=https://YOUR-PROD-BACKEND.onrender.com
 *   APP_PUBLIC_URL=https://converttide.com
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(resolve(process.cwd(), ".env.live"));
loadEnvFile(resolve(process.cwd(), ".env"));

const stripeKey = (process.env.STRIPE_SECRET_KEY || "").trim();
const paystackKey = (process.env.PAYSTACK_SECRET_KEY || "").trim();
const backendUrl = (process.env.BACKEND_PUBLIC_URL || "").replace(/\/$/, "");
const stripeOnly =
  process.env.STRIPE_ONLY === "1" ||
  process.env.STRIPE_ONLY === "true" ||
  process.env.PAYSTACK_ENABLED === "false" ||
  !paystackKey;

if (!stripeKey.startsWith("sk_live_")) {
  console.error("STRIPE_SECRET_KEY must be a LIVE key (sk_live_...). Put it in .env.live");
  process.exit(1);
}
if (!stripeOnly && !paystackKey.startsWith("sk_live_")) {
  console.error("PAYSTACK_SECRET_KEY must be a LIVE key (sk_live_...), or set STRIPE_ONLY=true");
  process.exit(1);
}

async function stripeForm(path, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    body.append(k, String(v));
  }
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe ${path}: ${json.error?.message || JSON.stringify(json)}`);
  }
  return json;
}

async function stripeGet(path) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${stripeKey}` },
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe GET ${path}: ${json.error?.message || JSON.stringify(json)}`);
  }
  return json;
}

async function paystack(path, method = "GET", body) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${paystackKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok || json.status === false) {
    throw new Error(`Paystack ${path}: ${json.message || JSON.stringify(json)}`);
  }
  return json.data;
}

async function ensureStripeProduct(name, metadata) {
  const existing = await stripeGet(`/products/search?query=${encodeURIComponent(`name:'${name}' AND active:'true'`)}`);
  if (existing.data?.[0]) return existing.data[0];
  return stripeForm("/products", {
    name,
    "metadata[app]": "converttide",
    ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`metadata[${k}]`, v])),
  });
}

async function ensureStripePrice({ productId, unitAmount, interval, nickname }) {
  const list = await stripeGet(
    `/prices?product=${productId}&active=true&limit=100`
  );
  const found = (list.data || []).find(
    (p) =>
      p.unit_amount === unitAmount &&
      p.currency === "usd" &&
      p.recurring?.interval === interval
  );
  if (found) return found;
  return stripeForm("/prices", {
    product: productId,
    unit_amount: unitAmount,
    currency: "usd",
    "recurring[interval]": interval,
    nickname,
  });
}

async function ensurePaystackPlan({ name, amount, interval }) {
  const plans = await paystack("/plan");
  const found = (plans || []).find(
    (p) =>
      p.amount === amount &&
      p.interval === interval &&
      String(p.currency).toUpperCase() === "NGN" &&
      p.name === name
  );
  if (found) return found;
  return paystack("/plan", "POST", {
    name,
    amount,
    interval,
    currency: "NGN",
  });
}

async function ensureStripeWebhook() {
  if (!backendUrl) return null;
  const endpoint = `${backendUrl}/api/billing/webhook`;
  const list = await stripeGet("/webhook_endpoints?limit=100");
  const existing = (list.data || []).find((w) => w.url === endpoint && w.status === "enabled");
  if (existing) {
    console.log(`Stripe webhook already exists: ${existing.id} (secret only shown at creation)`);
    return { id: existing.id, secret: null };
  }
  const created = await stripeForm("/webhook_endpoints", {
    url: endpoint,
    "enabled_events[]": [
      "checkout.session.completed",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.paid",
      "invoice.payment_failed",
    ].join(","), // fallback; Stripe form may need repeated keys
  });
  // Stripe expects repeated enabled_events - redo properly if needed
  if (!created.secret) {
    // recreate with repeated fields
  }
  return created;
}

async function createStripeWebhookProper() {
  if (!backendUrl) return null;
  const endpoint = `${backendUrl}/api/billing/webhook`;
  const list = await stripeGet("/webhook_endpoints?limit=100");
  const existing = (list.data || []).find((w) => w.url === endpoint);
  if (existing) {
    console.log(`Stripe webhook already exists for ${endpoint} (${existing.id}).`);
    console.log("If you need a new signing secret, delete it in Dashboard and re-run.");
    return { id: existing.id, secret: null };
  }
  const body = new URLSearchParams();
  body.append("url", endpoint);
  for (const event of [
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
  ]) {
    body.append("enabled_events[]", event);
  }
  const res = await fetch("https://api.stripe.com/v1/webhook_endpoints", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe webhook: ${json.error?.message || JSON.stringify(json)}`);
  return json;
}

const catalog = {
  proMonthly: 4900,
  enterpriseMonthly: 7900,
  proYearly: 49000,
  enterpriseYearly: 79000,
  paystackProMonthly: 4_900_000,
  paystackEnterpriseMonthly: 7_900_000,
  paystackProYearly: 49_000_000,
  paystackEnterpriseYearly: 79_000_000,
};

console.log("Creating LIVE Stripe products/prices…");
const proProduct = await ensureStripeProduct("Convert Tide Pro", { tier: "pro" });
const entProduct = await ensureStripeProduct("Convert Tide Enterprise", { tier: "enterprise" });

const stripePro = await ensureStripePrice({
  productId: proProduct.id,
  unitAmount: catalog.proMonthly,
  interval: "month",
  nickname: "Pro monthly",
});
const stripeEnt = await ensureStripePrice({
  productId: entProduct.id,
  unitAmount: catalog.enterpriseMonthly,
  interval: "month",
  nickname: "Enterprise monthly",
});
const stripeProYearly = await ensureStripePrice({
  productId: proProduct.id,
  unitAmount: catalog.proYearly,
  interval: "year",
  nickname: "Pro yearly (2 months free)",
});
const stripeEntYearly = await ensureStripePrice({
  productId: entProduct.id,
  unitAmount: catalog.enterpriseYearly,
  interval: "year",
  nickname: "Enterprise yearly (2 months free)",
});

let psPro = null;
let psEnt = null;
let psProYearly = null;
let psEntYearly = null;
if (!stripeOnly) {
  console.log("Creating LIVE Paystack plans…");
  psPro = await ensurePaystackPlan({
    name: "Convert Tide Pro",
    amount: catalog.paystackProMonthly,
    interval: "monthly",
  });
  psEnt = await ensurePaystackPlan({
    name: "Convert Tide Enterprise",
    amount: catalog.paystackEnterpriseMonthly,
    interval: "monthly",
  });
  psProYearly = await ensurePaystackPlan({
    name: "Convert Tide Pro Yearly",
    amount: catalog.paystackProYearly,
    interval: "annually",
  });
  psEntYearly = await ensurePaystackPlan({
    name: "Convert Tide Enterprise Yearly",
    amount: catalog.paystackEnterpriseYearly,
    interval: "annually",
  });
} else {
  console.log("Skipping Paystack (STRIPE_ONLY / PAYSTACK_ENABLED=false).");
}

console.log("Ensuring Stripe webhook…");
const webhook = await createStripeWebhookProper();

const pub = (process.env.STRIPE_PUBLISHABLE_KEY || "").trim();
const pspub = (process.env.PAYSTACK_PUBLIC_KEY || "").trim();

function mask(value) {
  if (!value || value.length < 12) return "<set locally>";
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

console.log("\n========== PASTE INTO RENDER (production backend) ==========\n");
console.log(`BILLING_PROVIDER=stripe`);
console.log(`PAYSTACK_ENABLED=false`);
console.log(`STRIPE_SECRET_KEY=<from .env.live, starts ${mask(stripeKey)}>`);
if (pub) console.log(`STRIPE_PUBLISHABLE_KEY=<from .env.live, starts ${mask(pub)}>`);
if (webhook?.secret) {
  console.log(`STRIPE_WEBHOOK_SECRET=${webhook.secret}`);
  console.log(`(webhook secret shown once; also saved note below)`);
} else {
  console.log(`STRIPE_WEBHOOK_SECRET=<already exists; copy from Stripe Dashboard → Webhooks if needed>`);
}
console.log(`STRIPE_CURRENCY=usd`);
console.log(`STRIPE_PRICE_PRO=${stripePro.id}`);
console.log(`STRIPE_PRICE_ENTERPRISE=${stripeEnt.id}`);
console.log(`STRIPE_PRICE_SCALE=${stripeEnt.id}`);
console.log(`STRIPE_PRICE_PRO_YEARLY=${stripeProYearly.id}`);
console.log(`STRIPE_PRICE_ENTERPRISE_YEARLY=${stripeEntYearly.id}`);
console.log(`STRIPE_PRICE_SCALE_YEARLY=${stripeEntYearly.id}`);
console.log(`STRIPE_CREDITS_ADDON_AMOUNT_CENTS=2900`);
if (!stripeOnly && psPro && psEnt && psProYearly && psEntYearly) {
  console.log(`PAYSTACK_SECRET_KEY=<from .env.live, starts ${mask(paystackKey)}>`);
  if (pspub) console.log(`PAYSTACK_PUBLIC_KEY=<from .env.live, starts ${mask(pspub)}>`);
  console.log(`PAYSTACK_CURRENCY=NGN`);
  console.log(`PAYSTACK_PLAN_PRO=${psPro.plan_code}`);
  console.log(`PAYSTACK_PLAN_ENTERPRISE=${psEnt.plan_code}`);
  console.log(`PAYSTACK_PLAN_SCALE=${psEnt.plan_code}`);
  console.log(`PAYSTACK_PLAN_PRO_YEARLY=${psProYearly.plan_code}`);
  console.log(`PAYSTACK_PLAN_ENTERPRISE_YEARLY=${psEntYearly.plan_code}`);
  console.log(`PAYSTACK_PLAN_SCALE_YEARLY=${psEntYearly.plan_code}`);
  console.log(`PAYSTACK_CREDITS_ADDON_AMOUNT_KOBO=2900000`);
}
if (backendUrl) {
  console.log(`BACKEND_PUBLIC_URL=${backendUrl}`);
}
console.log("\nFull secret values were not reprinted. Copy STRIPE_* keys from .env.live.");
console.log("Done. Redeploy / restart the production backend after saving env.");

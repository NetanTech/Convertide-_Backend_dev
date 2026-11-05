import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
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
    out[key] = value;
  }
  return out;
}

const env = {
  ...loadEnvFile(resolve(process.cwd(), ".env")),
  ...loadEnvFile(resolve(process.cwd(), ".env.live")),
};

const key = (env.STRIPE_SECRET_KEY || "").trim();
const backend = (env.BACKEND_PUBLIC_URL || "").replace(/\/$/, "");

if (!key.startsWith("sk_live_")) {
  console.error("FAIL: STRIPE_SECRET_KEY in .env.live is not sk_live_");
  process.exit(1);
}

const priceIds = [
  ["PRO monthly", env.STRIPE_PRICE_PRO],
  ["ENTERPRISE monthly", env.STRIPE_PRICE_ENTERPRISE || env.STRIPE_PRICE_SCALE],
  ["PRO yearly", env.STRIPE_PRICE_PRO_YEARLY],
  ["ENTERPRISE yearly", env.STRIPE_PRICE_ENTERPRISE_YEARLY || env.STRIPE_PRICE_SCALE_YEARLY],
];

async function stripeGet(path) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20000),
  });
  return { ok: res.ok, status: res.status, json: await res.json() };
}

console.log("1) API key mode: LIVE");

let pricesOk = true;
console.log("\n2) Prices");
for (const [label, id] of priceIds) {
  if (!id) {
    console.log(`  FAIL ${label}: missing env`);
    pricesOk = false;
    continue;
  }
  const { ok, json } = await stripeGet(`/prices/${id}`);
  if (!ok) {
    console.log(`  FAIL ${label}: ${id} → ${json.error?.message || "error"}`);
    pricesOk = false;
    continue;
  }
  const amount = `${(json.unit_amount / 100).toFixed(json.unit_amount % 100 ? 2 : 0)} ${String(json.currency).toUpperCase()}`;
  console.log(
    `  OK ${label}: ${json.id} | ${amount}/${json.recurring?.interval} | livemode=${json.livemode}`
  );
  if (!json.livemode) pricesOk = false;
}

console.log("\n3) Webhook endpoint");
const hooks = await stripeGet("/webhook_endpoints?limit=30");
let webhookOk = false;
if (!hooks.ok) {
  console.log(`  FAIL list webhooks: ${hooks.json.error?.message || hooks.status}`);
} else {
  const matches = (hooks.json.data || []).filter((w) =>
    String(w.url || "").includes("/api/billing/webhook")
  );
  if (!matches.length) {
    console.log("  FAIL: no webhook ending in /api/billing/webhook");
  } else {
    for (const w of matches) {
      console.log(`  OK ${w.id} | ${w.status} | livemode=${w.livemode} | ${w.url}`);
      if (w.status === "enabled" && w.livemode) webhookOk = true;
    }
  }
}

console.log("\n4) Backend health");
let backendOk = false;
if (!backend) {
  console.log("  FAIL: BACKEND_PUBLIC_URL missing");
} else {
  try {
    const res = await fetch(`${backend}/health`, {
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    console.log(`  ${res.status} ${backend}/health → ${text.slice(0, 140)}`);
    backendOk = res.ok;
  } catch (err) {
    console.log(`  FAIL ${backend}/health → ${err.message}`);
  }
}

console.log("\n========== RESULT ==========");
console.log(`Prices:  ${pricesOk ? "PASS" : "FAIL"}`);
console.log(`Webhook: ${webhookOk ? "PASS" : "FAIL"}`);
console.log(`Backend: ${backendOk ? "PASS" : "FAIL (cold start / path?)"}`);
console.log(`
Manual checkout test (safest):
1. Open https://converttide.com/dashboard/billing/plans (logged in)
2. Click Upgrade on Pro (monthly or yearly)
3. Stripe Checkout URL/host should be checkout.stripe.com
4. On the payment page, confirm it does NOT say \"Test mode\"
5. You can close without paying, or pay with a real card and refund in Stripe → Payments

If checkout fails with a price/config error, Render env is wrong or service was not restarted.
`);

process.exit(pricesOk && webhookOk ? 0 : 1);

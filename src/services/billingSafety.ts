import { supabaseAdmin } from "../config/supabase";

export type BillingProviderName = "stripe" | "paystack";

type ClaimResult = "claimed" | "already_completed" | "retry";

/**
 * Insert-or-inspect a webhook event. Returns:
 * - claimed: first time (or prior attempt failed) — caller should process
 * - already_completed: safe no-op (replay)
 * - retry: another worker is mid-flight on a fresh claim — acknowledge without re-running
 */
export async function beginWebhookEvent(
  provider: BillingProviderName,
  eventId: string,
  eventType?: string
): Promise<ClaimResult> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from("billing_webhook_events").insert({
    provider,
    event_id: eventId,
    event_type: eventType ?? null,
    status: "processing",
    received_at: now,
  });

  if (!error) return "claimed";

  // Unique violation → already seen
  if (error.code !== "23505") {
    throw new Error(`billing_webhook_events insert: ${error.message}`);
  }

  const { data } = await supabaseAdmin
    .from("billing_webhook_events")
    .select("status, received_at")
    .eq("provider", provider)
    .eq("event_id", eventId)
    .maybeSingle();

  const row = data as { status?: string; received_at?: string } | null;
  if (!row) return "claimed";

  if (row.status === "completed") return "already_completed";

  // Stale processing (>2 min) — allow retry after marking failed
  const receivedMs = row.received_at ? new Date(row.received_at).getTime() : 0;
  if (row.status === "processing" && Date.now() - receivedMs < 2 * 60 * 1000) {
    return "retry";
  }

  await supabaseAdmin
    .from("billing_webhook_events")
    .update({ status: "processing", error_message: null, received_at: now })
    .eq("provider", provider)
    .eq("event_id", eventId);

  return "claimed";
}

export async function completeWebhookEvent(
  provider: BillingProviderName,
  eventId: string
): Promise<void> {
  await supabaseAdmin
    .from("billing_webhook_events")
    .update({ status: "completed", completed_at: new Date().toISOString(), error_message: null })
    .eq("provider", provider)
    .eq("event_id", eventId);
}

export async function failWebhookEvent(
  provider: BillingProviderName,
  eventId: string,
  message: string
): Promise<void> {
  await supabaseAdmin
    .from("billing_webhook_events")
    .update({
      status: "failed",
      error_message: message.slice(0, 500),
      completed_at: new Date().toISOString(),
    })
    .eq("provider", provider)
    .eq("event_id", eventId);
}

/**
 * Claim a one-time fulfillment key (checkout session, Paystack reference, credits pack).
 * Returns true if this caller owns the work; false if already completed / in flight.
 */
export async function claimFulfillment(
  fulfillmentKey: string,
  kind: string,
  userId?: string | null,
  metadata: Record<string, unknown> = {}
): Promise<boolean> {
  const { error } = await supabaseAdmin.from("billing_fulfillments").insert({
    fulfillment_key: fulfillmentKey,
    user_id: userId ?? null,
    kind,
    status: "processing",
    metadata,
  });

  if (!error) return true;

  if (error.code !== "23505") {
    throw new Error(`billing_fulfillments insert: ${error.message}`);
  }

  const { data } = await supabaseAdmin
    .from("billing_fulfillments")
    .select("status, created_at")
    .eq("fulfillment_key", fulfillmentKey)
    .maybeSingle();

  const row = data as { status?: string; created_at?: string } | null;
  if (!row) return true;

  if (row.status === "completed") return false;

  const createdMs = row.created_at ? new Date(row.created_at).getTime() : 0;
  if (row.status === "processing" && Date.now() - createdMs < 2 * 60 * 1000) {
    return false;
  }

  // Stale failed/processing — reclaim
  const { error: updateError } = await supabaseAdmin
    .from("billing_fulfillments")
    .update({
      status: "processing",
      user_id: userId ?? null,
      kind,
      metadata,
      created_at: new Date().toISOString(),
      completed_at: null,
    })
    .eq("fulfillment_key", fulfillmentKey)
    .neq("status", "completed");

  if (updateError) {
    throw new Error(`billing_fulfillments reclaim: ${updateError.message}`);
  }

  return true;
}

export async function completeFulfillment(fulfillmentKey: string): Promise<void> {
  await supabaseAdmin
    .from("billing_fulfillments")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("fulfillment_key", fulfillmentKey);
}

export async function releaseFulfillment(fulfillmentKey: string, message?: string): Promise<void> {
  await supabaseAdmin
    .from("billing_fulfillments")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      metadata: message ? { error: message.slice(0, 500) } : {},
    })
    .eq("fulfillment_key", fulfillmentKey)
    .eq("status", "processing");
}

export async function logBillingAudit(input: {
  userId?: string | null;
  action: string;
  actor?: string;
  provider?: string | null;
  reference?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("billing_audit_log").insert({
    user_id: input.userId ?? null,
    action: input.action,
    actor: input.actor ?? "system",
    provider: input.provider ?? null,
    reference: input.reference ?? null,
    metadata: input.metadata ?? {},
  });

  if (error) {
    // Never fail a payment path because audit insert failed — log and continue.
    console.warn("[billing-audit]", error.message, input.action);
  }
}

export function httpError(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

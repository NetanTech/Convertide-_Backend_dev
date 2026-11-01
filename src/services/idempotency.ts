import { supabaseAdmin } from "../config/supabase";

export type IdempotencyScope = "campaign_generate" | "campaign_publish" | string;

type IdempotencyRow = {
  id: string;
  status: "processing" | "completed" | "failed";
  resource_id: string | null;
  response: Record<string, unknown>;
  error_message: string | null;
};

/**
 * Claim a client request key. Returns an existing completed/failed/processing
 * record so retries never create a second side effect.
 */
export async function claimIdempotencyKey(input: {
  userId: string;
  businessId?: string | null;
  scope: IdempotencyScope;
  requestKey: string;
}): Promise<
  | { kind: "claimed" }
  | { kind: "completed"; resourceId: string | null; response: Record<string, unknown> }
  | { kind: "processing" }
  | { kind: "failed"; message: string | null }
> {
  const key = input.requestKey.trim().slice(0, 128);
  if (!key) throw new Error("clientRequestId is required");

  const { error } = await supabaseAdmin.from("request_idempotency").insert({
    user_id: input.userId,
    business_id: input.businessId ?? null,
    scope: input.scope,
    request_key: key,
    status: "processing",
  });

  if (!error) return { kind: "claimed" };

  if (!/duplicate|unique/i.test(error.message)) {
    throw new Error(error.message);
  }

  const { data, error: fetchError } = await supabaseAdmin
    .from("request_idempotency")
    .select("id, status, resource_id, response, error_message")
    .eq("user_id", input.userId)
    .eq("scope", input.scope)
    .eq("request_key", key)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!data) throw new Error("Idempotency conflict and record missing");

  const row = data as IdempotencyRow;
  if (row.status === "completed") {
    return {
      kind: "completed",
      resourceId: row.resource_id,
      response: (row.response as Record<string, unknown>) ?? {},
    };
  }
  if (row.status === "failed") {
    // Same clientRequestId may retry after a failed attempt — reclaim the key.
    await supabaseAdmin
      .from("request_idempotency")
      .delete()
      .eq("id", row.id)
      .eq("status", "failed");

    const { error: reclaimError } = await supabaseAdmin.from("request_idempotency").insert({
      user_id: input.userId,
      business_id: input.businessId ?? null,
      scope: input.scope,
      request_key: key,
      status: "processing",
    });

    if (!reclaimError) return { kind: "claimed" };
    if (/duplicate|unique/i.test(reclaimError.message)) {
      return { kind: "processing" };
    }
    throw new Error(reclaimError.message);
  }
  return { kind: "processing" };
}

export async function completeIdempotencyKey(input: {
  userId: string;
  scope: IdempotencyScope;
  requestKey: string;
  resourceId: string;
  response: Record<string, unknown>;
}): Promise<void> {
  await supabaseAdmin
    .from("request_idempotency")
    .update({
      status: "completed",
      resource_id: input.resourceId,
      response: input.response,
      completed_at: new Date().toISOString(),
      error_message: null,
    })
    .eq("user_id", input.userId)
    .eq("scope", input.scope)
    .eq("request_key", input.requestKey.trim().slice(0, 128));
}

export async function failIdempotencyKey(input: {
  userId: string;
  scope: IdempotencyScope;
  requestKey: string;
  message: string;
}): Promise<void> {
  // Leave status as failed so a *new* clientRequestId is required for a fresh attempt,
  // while retries of the same key can surface the failure without creating resources.
  await supabaseAdmin
    .from("request_idempotency")
    .update({
      status: "failed",
      error_message: input.message.slice(0, 500),
      completed_at: new Date().toISOString(),
    })
    .eq("user_id", input.userId)
    .eq("scope", input.scope)
    .eq("request_key", input.requestKey.trim().slice(0, 128));
}

/**
 * Allow a fresh attempt after a failed request by deleting the failed key.
 * Successful keys stay forever so completed work cannot be double-created.
 */
export async function clearFailedIdempotencyKey(input: {
  userId: string;
  scope: IdempotencyScope;
  requestKey: string;
}): Promise<void> {
  await supabaseAdmin
    .from("request_idempotency")
    .delete()
    .eq("user_id", input.userId)
    .eq("scope", input.scope)
    .eq("request_key", input.requestKey.trim().slice(0, 128))
    .eq("status", "failed");
}

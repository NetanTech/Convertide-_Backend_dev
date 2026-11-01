import { supabaseAdmin } from "../config/supabase";

export async function logAccountAudit(input: {
  userId?: string | null;
  action: string;
  actor?: string;
  businessId?: string | null;
  reference?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("account_audit_log").insert({
    user_id: input.userId ?? null,
    action: input.action,
    actor: input.actor ?? "system",
    business_id: input.businessId ?? null,
    reference: input.reference ?? null,
    metadata: input.metadata ?? {},
  });

  if (error) {
    console.warn("[account-audit]", error.message, input.action);
  }
}

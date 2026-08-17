import { supabaseAdmin } from "../config/supabase";

export type NotificationPrefs = {
  personaGenerated: boolean;
  campaignGenerated: boolean;
  marketingPlanGenerated: boolean;
  aiCreditsLow: boolean;
  billingUpdates: boolean;
  emailNotification: boolean;
};

export type AiPrefs = {
  contentTone: string;
  contentLength: string;
  preferredLanguage: string;
  autoSaveAiResults: boolean;
};

export type UserSettings = {
  notifications: NotificationPrefs;
  ai: AiPrefs;
};

type SettingsRow = {
  persona_generated: boolean;
  campaign_generated: boolean;
  marketing_plan_generated: boolean;
  ai_credits_low: boolean;
  billing_updates: boolean;
  email_notification: boolean;
  content_tone: string;
  content_length: string;
  preferred_language: string;
  auto_save_ai_results: boolean;
};

const defaults: UserSettings = {
  notifications: {
    personaGenerated: true,
    campaignGenerated: true,
    marketingPlanGenerated: true,
    aiCreditsLow: true,
    billingUpdates: true,
    emailNotification: false,
  },
  ai: {
    contentTone: "",
    contentLength: "",
    preferredLanguage: "",
    autoSaveAiResults: true,
  },
};

function toSettings(row: SettingsRow | null): UserSettings {
  if (!row) return defaults;
  return {
    notifications: {
      personaGenerated: row.persona_generated,
      campaignGenerated: row.campaign_generated,
      marketingPlanGenerated: row.marketing_plan_generated,
      aiCreditsLow: row.ai_credits_low,
      billingUpdates: row.billing_updates,
      emailNotification: row.email_notification,
    },
    ai: {
      contentTone: row.content_tone ?? "",
      contentLength: row.content_length ?? "",
      preferredLanguage: row.preferred_language ?? "",
      autoSaveAiResults: row.auto_save_ai_results,
    },
  };
}

export async function ensureUserSettings(userId: string): Promise<UserSettings> {
  const { data, error } = await supabaseAdmin
    .from("user_settings")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (data) return toSettings(data as SettingsRow);

  const { data: created, error: insertError } = await supabaseAdmin
    .from("user_settings")
    .upsert({ user_id: userId }, { onConflict: "user_id" })
    .select("*")
    .single();

  if (insertError) {
    throw new Error(insertError.message);
  }

  return toSettings(created as SettingsRow);
}

export async function updateUserSettings(
  userId: string,
  patch: {
    notifications?: Partial<NotificationPrefs>;
    ai?: Partial<AiPrefs>;
  }
): Promise<UserSettings> {
  await ensureUserSettings(userId);

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (patch.notifications) {
    if (patch.notifications.personaGenerated !== undefined)
      updates.persona_generated = patch.notifications.personaGenerated;
    if (patch.notifications.campaignGenerated !== undefined)
      updates.campaign_generated = patch.notifications.campaignGenerated;
    if (patch.notifications.marketingPlanGenerated !== undefined)
      updates.marketing_plan_generated = patch.notifications.marketingPlanGenerated;
    if (patch.notifications.aiCreditsLow !== undefined)
      updates.ai_credits_low = patch.notifications.aiCreditsLow;
    if (patch.notifications.billingUpdates !== undefined)
      updates.billing_updates = patch.notifications.billingUpdates;
    if (patch.notifications.emailNotification !== undefined)
      updates.email_notification = patch.notifications.emailNotification;
  }

  if (patch.ai) {
    if (patch.ai.contentTone !== undefined) updates.content_tone = patch.ai.contentTone;
    if (patch.ai.contentLength !== undefined) updates.content_length = patch.ai.contentLength;
    if (patch.ai.preferredLanguage !== undefined)
      updates.preferred_language = patch.ai.preferredLanguage;
    if (patch.ai.autoSaveAiResults !== undefined)
      updates.auto_save_ai_results = patch.ai.autoSaveAiResults;
  }

  const { data, error } = await supabaseAdmin
    .from("user_settings")
    .update(updates)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to update settings");
  }

  return toSettings(data as SettingsRow);
}

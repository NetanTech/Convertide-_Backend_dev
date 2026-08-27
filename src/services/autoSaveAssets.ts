import { supabaseAdmin } from "../config/supabase";
import { ensureUserSettings } from "./settings";

type AutoSaveCopyInput = {
  title: string;
  excerpt: string;
  personaId?: string | null;
  personaName?: string;
  campaignId?: string | null;
  campaignName?: string;
  platform?: string;
};

/**
 * When "Auto-save AI Results" is on, store a copy asset in the user's library.
 * Failures are logged and ignored so generation still succeeds.
 */
export async function maybeAutoSaveAiCopy(userId: string, input: AutoSaveCopyInput) {
  try {
    const settings = await ensureUserSettings(userId);
    if (!settings.ai.autoSaveAiResults) return;

    const { error } = await supabaseAdmin.from("assets").insert({
      user_id: userId,
      type: "copy",
      title: input.title,
      excerpt: input.excerpt.slice(0, 2000),
      persona_id: input.personaId ?? null,
      persona_name: input.personaName ?? "",
      campaign_id: input.campaignId ?? null,
      campaign_name: input.campaignName ?? "",
      platform: input.platform ?? "AI",
      file_url: null,
    });

    if (error) {
      console.error("[autoSave] failed to save AI asset", error.message);
    }
  } catch (err) {
    console.error("[autoSave] unexpected error", err);
  }
}

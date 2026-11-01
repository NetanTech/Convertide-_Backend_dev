import { supabaseAdmin } from "../config/supabase";
import { buildCampaignPayload, buildPlanPayload } from "./generators";
import { ensureUserSettings } from "./settings";
import { savePlanVersion } from "./planVersions";
import { logAccountAudit } from "./accountAudit";
import { createNotification } from "./notifications";

export type PersonaDependentSummary = {
  campaigns: Array<{ id: string; name: string }>;
  plans: Array<{ id: string; name: string }>;
};

type PersonaRow = {
  id: string;
  name: string;
  demographics: { label: string; value: string }[] | null;
  psychographics: string[] | null;
  pain_points: string[] | null;
  goals: string[] | null;
  buying_triggers: string[] | null;
};

function parseDurationDays(timeline: unknown): number | undefined {
  if (!timeline || typeof timeline !== "object") return undefined;
  const duration = (timeline as { duration?: unknown }).duration;
  if (typeof duration !== "string") return undefined;
  const match = duration.match(/(\d+)/);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function listPersonaDependents(input: {
  userId: string;
  businessId: string;
  personaId: string;
}): Promise<PersonaDependentSummary> {
  const [campaignsRes, plansRes] = await Promise.all([
    supabaseAdmin
      .from("campaigns")
      .select("id, name")
      .eq("user_id", input.userId)
      .eq("business_id", input.businessId)
      .eq("persona_id", input.personaId)
      .order("updated_at", { ascending: false }),
    supabaseAdmin
      .from("plans")
      .select("id, name")
      .eq("user_id", input.userId)
      .eq("business_id", input.businessId)
      .eq("persona_id", input.personaId)
      .order("updated_at", { ascending: false }),
  ]);

  if (campaignsRes.error) throw new Error(campaignsRes.error.message);
  if (plansRes.error) throw new Error(plansRes.error.message);

  return {
    campaigns: ((campaignsRes.data ?? []) as Array<{ id: string; name: string }>).map((row) => ({
      id: row.id,
      name: row.name,
    })),
    plans: ((plansRes.data ?? []) as Array<{ id: string; name: string }>).map((row) => ({
      id: row.id,
      name: row.name,
    })),
  };
}

export async function regeneratePersonaDependents(input: {
  userId: string;
  businessId: string;
  personaId: string;
  campaignIds?: string[] | null;
  planIds?: string[] | null;
}): Promise<{
  campaignsUpdated: Array<{ id: string; name: string }>;
  plansUpdated: Array<{ id: string; name: string }>;
  errors: Array<{ type: "campaign" | "plan"; id: string; message: string }>;
}> {
  const { data: persona, error: personaError } = await supabaseAdmin
    .from("personas")
    .select("id, name, demographics, psychographics, pain_points, goals, buying_triggers")
    .eq("user_id", input.userId)
    .eq("business_id", input.businessId)
    .eq("id", input.personaId)
    .maybeSingle();

  if (personaError) throw new Error(personaError.message);
  if (!persona) throw new Error("Persona not found");

  const personaRow = persona as PersonaRow;
  const dependents = await listPersonaDependents(input);

  const campaignIds =
    input.campaignIds && input.campaignIds.length > 0
      ? input.campaignIds.filter((id) => dependents.campaigns.some((c) => c.id === id))
      : dependents.campaigns.map((c) => c.id);

  const planIds =
    input.planIds && input.planIds.length > 0
      ? input.planIds.filter((id) => dependents.plans.some((p) => p.id === id))
      : dependents.plans.map((p) => p.id);

  const aiPrefs = (await ensureUserSettings(input.userId)).ai;
  const campaignsUpdated: Array<{ id: string; name: string }> = [];
  const plansUpdated: Array<{ id: string; name: string }> = [];
  const errors: Array<{ type: "campaign" | "plan"; id: string; message: string }> = [];

  // DB stores psychographics/pain_points/goals as string[]; generators accept a looser shape via cast.
  const personaLite = {
    id: personaRow.id,
    name: personaRow.name,
    demographics: personaRow.demographics ?? [],
    psychographics: personaRow.psychographics ?? [],
    pain_points: personaRow.pain_points ?? [],
    goals: personaRow.goals ?? [],
    buying_triggers: personaRow.buying_triggers ?? [],
  } as unknown as Parameters<typeof buildCampaignPayload>[1];

  for (const campaignId of campaignIds) {
    try {
      const { data: campaign, error } = await supabaseAdmin
        .from("campaigns")
        .select("*")
        .eq("user_id", input.userId)
        .eq("business_id", input.businessId)
        .eq("persona_id", input.personaId)
        .eq("id", campaignId)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!campaign) throw new Error("Campaign not found");

      const row = campaign as {
        id: string;
        name: string;
        duration: number | null;
        stats: Record<string, unknown> | null;
      };
      const channels = Array.isArray(row.stats?.targetChannels)
        ? (row.stats!.targetChannels as string[])
        : undefined;

      const payload = await buildCampaignPayload(
        input.userId,
        personaLite,
        row.name,
        row.duration ?? undefined,
        aiPrefs,
        channels
      );

      const { error: updateError } = await supabaseAdmin
        .from("campaigns")
        .update({
          persona_name: personaRow.name,
          stats: payload.stats,
          tabs: payload.tabs,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("user_id", input.userId)
        .eq("business_id", input.businessId);

      if (updateError) throw new Error(updateError.message);
      campaignsUpdated.push({ id: row.id, name: row.name });
    } catch (err) {
      errors.push({
        type: "campaign",
        id: campaignId,
        message: err instanceof Error ? err.message : "Campaign refresh failed",
      });
    }
  }

  for (const planId of planIds) {
    try {
      const { data: plan, error } = await supabaseAdmin
        .from("plans")
        .select("*")
        .eq("user_id", input.userId)
        .eq("business_id", input.businessId)
        .eq("persona_id", input.personaId)
        .eq("id", planId)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!plan) throw new Error("Plan not found");

      const row = plan as Record<string, unknown> & {
        id: string;
        name: string;
        budget: string | null;
        timeline: unknown;
        campaign_id: string | null;
        campaign_snapshot: { name?: string } | null;
      };

      try {
        await savePlanVersion({
          userId: input.userId,
          planId: row.id,
          row: plan as Record<string, unknown>,
          reason: "persona_dependent_refresh",
        });
      } catch (err) {
        console.warn("[persona-dependents] plan version snapshot failed", err);
      }

      let campaign: { id: string; name: string } | null = null;
      if (row.campaign_id) {
        campaign = {
          id: row.campaign_id,
          name: row.campaign_snapshot?.name || "Campaign",
        };
      }

      const payload = await buildPlanPayload({
        userId: input.userId,
        persona: {
          id: personaLite.id,
          name: personaLite.name,
          demographics: personaLite.demographics,
        },
        campaign,
        name: row.name,
        budget: row.budget ?? undefined,
        durationDays: parseDurationDays(row.timeline),
        aiPrefs,
      });

      const { error: updateError } = await supabaseAdmin
        .from("plans")
        .update({
          persona_snapshot: payload.persona_snapshot,
          campaign_snapshot: payload.campaign_snapshot,
          channel_mix: payload.channel_mix,
          weekly_action_plan: payload.weekly_action_plan,
          content_calendar: payload.content_calendar,
          kpis: payload.kpis,
          expected_outcome: payload.expected_outcome,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("user_id", input.userId)
        .eq("business_id", input.businessId);

      if (updateError) throw new Error(updateError.message);
      plansUpdated.push({ id: row.id, name: row.name });
    } catch (err) {
      errors.push({
        type: "plan",
        id: planId,
        message: err instanceof Error ? err.message : "Plan refresh failed",
      });
    }
  }

  await logAccountAudit({
    userId: input.userId,
    businessId: input.businessId,
    action: "persona.dependents_regenerate",
    actor: "user",
    reference: input.personaId,
    metadata: {
      campaignsUpdated: campaignsUpdated.map((c) => c.id),
      plansUpdated: plansUpdated.map((p) => p.id),
      errors,
    },
  });

  if (campaignsUpdated.length || plansUpdated.length) {
    await createNotification(input.userId, {
      category: "ai",
      title: "Dependents updated from persona",
      description: [
        campaignsUpdated.length
          ? `${campaignsUpdated.length} campaign${campaignsUpdated.length === 1 ? "" : "s"}`
          : null,
        plansUpdated.length
          ? `${plansUpdated.length} plan${plansUpdated.length === 1 ? "" : "s"}`
          : null,
      ]
        .filter(Boolean)
        .join(" and ") + ` refreshed for ${personaRow.name}.`,
      actionLabel: "View persona",
      actionHref: `/dashboard/personas/${input.personaId}`,
      actionTone: "insight",
    });
  }

  return { campaignsUpdated, plansUpdated, errors };
}

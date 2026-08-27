import { Router } from "express";
import { supabaseAdmin } from "../config/supabase";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import { createCampaignSchema, updateCampaignSchema } from "../schemas/campaign.schema";
import { buildCampaignPayload } from "../services/generators";
import { createNotification } from "../services/notifications";
import { consumeCredits, CREDIT_COSTS, InsufficientCreditsError } from "../services/billing";
import { ensureUserSettings } from "../services/settings";

const router = Router();

type CampaignRow = {
  id: string;
  user_id: string;
  persona_id: string | null;
  persona_name: string | null;
  name: string;
  status: "draft" | "active" | "completed";
  duration: number | null;
  conversions: { total: number; rate: number } | null;
  stats: Record<string, unknown>;
  tabs: unknown[];
  created_at: string;
  updated_at: string | null;
};

function toCampaign(row: CampaignRow) {
  return {
    id: row.id,
    personaId: row.persona_id,
    personaName: row.persona_name,
    name: row.name,
    generatedAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    status: row.status ?? "active",
    duration: row.duration ?? undefined,
    conversions: row.conversions ?? undefined,
    stats: row.stats,
    tabs: row.tabs,
  };
}

/** Attach selected library assets to a newly created campaign. */
async function linkAssetsToCampaign(
  userId: string,
  campaignId: string,
  campaignName: string,
  personaId: string | null,
  personaName: string | null,
  assetIds: string[] | undefined
) {
  if (!assetIds?.length) return;
  await supabaseAdmin
    .from("assets")
    .update({
      campaign_id: campaignId,
      campaign_name: campaignName,
      persona_id: personaId,
      persona_name: personaName ?? "",
    })
    .eq("user_id", userId)
    .in("id", assetIds);
}

// GET /api/campaigns
router.get(
  "/",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "6"), 10) || 6));
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const personaName = typeof req.query.personaName === "string" ? req.query.personaName.trim() : "";
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabaseAdmin
      .from("campaigns")
      .select("*", { count: "exact" })
      .eq("user_id", req.user!.id);

    if (status && status !== "all") {
      query = query.eq("status", status);
    }
    if (personaName) {
      query = query.eq("persona_name", personaName);
    }
    if (search) {
      query = query.or(`name.ilike.*${search}*,persona_name.ilike.*${search}*`);
    }

    const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);

    if (error) return res.status(500).json({ success: false, message: error.message });

    const total = count ?? 0;
    return res.json({
      success: true,
      data: {
        campaigns: (data as CampaignRow[]).map(toCampaign),
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      },
    });
  })
);

// POST /api/campaigns/generate
router.post(
  "/generate",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "personaId is required" });
    }

    const { data: persona, error: personaError } = await supabaseAdmin
      .from("personas")
      .select("id, name, demographics")
      .eq("user_id", req.user!.id)
      .eq("id", parsed.data.personaId)
      .maybeSingle();

    if (personaError) return res.status(500).json({ success: false, message: personaError.message });
    if (!persona) return res.status(404).json({ success: false, message: "Persona not found" });

    try {
      await consumeCredits(req.user!.id, CREDIT_COSTS.campaign, "campaign_generate");
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return res.status(402).json({ success: false, message: err.message });
      }
      throw err;
    }

    const aiPrefs = (await ensureUserSettings(req.user!.id)).ai;
    const payload = await buildCampaignPayload(
      { id: persona.id, name: persona.name, demographics: persona.demographics },
      parsed.data.name,
      parsed.data.durationDays,
      aiPrefs
    );

    const { data, error } = await supabaseAdmin
      .from("campaigns")
      .insert({
        user_id: req.user!.id,
        ...payload,
      })
      .select("*")
      .single();

    if (error || !data) {
      return res.status(500).json({ success: false, message: error?.message || "Failed to create campaign" });
    }

    await linkAssetsToCampaign(
      req.user!.id,
      (data as CampaignRow).id,
      payload.name,
      persona.id,
      persona.name,
      parsed.data.assetIds
    );

    await createNotification(req.user!.id, {
      category: "campaigns",
      title: "Campaign Ready",
      description: `${payload.name} generation complete. All assets, audience segments, and schedule windows are now live.`,
      actionLabel: "View Campaign",
      actionHref: `/dashboard/campaigns/${data.id}`,
      actionTone: "primary",
    });

    return res.status(201).json({ success: true, data: { campaign: toCampaign(data as CampaignRow) } });
  })
);

// POST /api/campaigns/draft � save without AI generation / credit spend
router.post(
  "/draft",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "personaId is required" });
    }

    const { data: persona, error: personaError } = await supabaseAdmin
      .from("personas")
      .select("id, name")
      .eq("user_id", req.user!.id)
      .eq("id", parsed.data.personaId)
      .maybeSingle();

    if (personaError) return res.status(500).json({ success: false, message: personaError.message });
    if (!persona) return res.status(404).json({ success: false, message: "Persona not found" });

    const name =
      parsed.data.name?.trim() ||
      `${persona.name || "Brand"} � Draft Campaign`;

    const { data, error } = await supabaseAdmin
      .from("campaigns")
      .insert({
        user_id: req.user!.id,
        persona_id: persona.id,
        persona_name: persona.name,
        name,
        status: "draft",
        duration: parsed.data.durationDays ?? null,
        conversions: { total: 0, rate: 0 },
        stats: {
          totalVariations: 0,
          headlines: 0,
          ctaVariations: 0,
          emotionalAngles: 0,
          readingScore: 0,
          readingScoreLabel: "Draft",
        },
        tabs: [],
      })
      .select("*")
      .single();

    if (error || !data) {
      return res.status(500).json({ success: false, message: error?.message || "Failed to save draft" });
    }

    await linkAssetsToCampaign(
      req.user!.id,
      (data as CampaignRow).id,
      name,
      persona.id,
      persona.name,
      parsed.data.assetIds
    );

    return res.status(201).json({ success: true, data: { campaign: toCampaign(data as CampaignRow) } });
  })
);
// GET /api/campaigns/:id
router.get(
  "/:id",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("campaigns")
      .select("*")
      .eq("user_id", req.user!.id)
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Campaign not found" });
    return res.json({ success: true, data: { campaign: toCampaign(data as CampaignRow) } });
  })
);

// POST /api/campaigns/:id/duplicate
router.post(
  "/:id/duplicate",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const { data: original, error: fetchError } = await supabaseAdmin
      .from("campaigns")
      .select("*")
      .eq("user_id", req.user!.id)
      .eq("id", req.params.id)
      .maybeSingle();

    if (fetchError) return res.status(500).json({ success: false, message: fetchError.message });
    if (!original) return res.status(404).json({ success: false, message: "Campaign not found" });

    const source = original as CampaignRow;
    const { data: created, error: insertError } = await supabaseAdmin
      .from("campaigns")
      .insert({
        user_id: req.user!.id,
        persona_id: source.persona_id,
        persona_name: source.persona_name,
        name: `${source.name} (Copy)`,
        status: "draft",
        duration: source.duration,
        conversions: { total: 0, rate: 0 },
        stats: source.stats,
        tabs: source.tabs,
      })
      .select("*")
      .single();

    if (insertError || !created) {
      return res.status(500).json({ success: false, message: insertError?.message || "Failed to duplicate campaign" });
    }

    return res.status(201).json({ success: true, data: { campaign: toCampaign(created as CampaignRow) } });
  })
);

// PATCH /api/campaigns/:id
router.patch(
  "/:id",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = updateCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Invalid campaign update" });
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      ...parsed.data,
    };

    const { data, error } = await supabaseAdmin
      .from("campaigns")
      .update(updates)
      .eq("user_id", req.user!.id)
      .eq("id", req.params.id)
      .select("*")
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Campaign not found" });
    return res.json({ success: true, data: { campaign: toCampaign(data as CampaignRow) } });
  })
);

// DELETE /api/campaigns/:id
router.delete(
  "/:id",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("campaigns")
      .delete()
      .eq("user_id", req.user!.id)
      .eq("id", req.params.id)
      .select("id")
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Campaign not found" });
    return res.json({ success: true, message: "Campaign deleted" });
  })
);

export default router;

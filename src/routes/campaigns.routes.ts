import { Router } from "express";
import { supabaseAdmin } from "../config/supabase";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import { createCampaignSchema, updateCampaignSchema } from "../schemas/campaign.schema";
import { buildCampaignPayload } from "../services/generators";
import { createNotification } from "../services/notifications";

const router = Router();

type CampaignRow = {
  id: string;
  user_id: string;
  persona_id: string | null;
  name: string;
  stats: Record<string, unknown>;
  tabs: unknown[];
  created_at: string;
  updated_at: string | null;
};

function toCampaign(row: CampaignRow) {
  return {
    id: row.id,
    personaId: row.persona_id,
    name: row.name,
    generatedAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    stats: row.stats,
    tabs: row.tabs,
  };
}

// GET /api/campaigns
router.get(
  "/",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("campaigns")
      .select("*")
      .eq("user_id", req.user!.id)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, data: { campaigns: (data as CampaignRow[]).map(toCampaign) } });
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

    const payload = buildCampaignPayload(
      { id: persona.id, name: persona.name, demographics: persona.demographics },
      parsed.data.name
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

import { Router } from "express";
import { supabaseAdmin } from "../config/supabase";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import { createAssetSchema } from "../schemas/asset.schema";

const router = Router();

type AssetRow = {
  id: string;
  user_id: string;
  campaign_id: string | null;
  persona_id: string | null;
  type: "image" | "copy" | "video";
  title: string;
  campaign_name: string;
  persona_name: string;
  platform: string;
  excerpt: string | null;
  created_at: string;
};

function toAsset(row: AssetRow) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    campaign: row.campaign_name,
    persona: row.persona_name,
    platform: row.platform,
    createdAt: row.created_at,
    excerpt: row.excerpt ?? undefined,
    campaignId: row.campaign_id,
    personaId: row.persona_id,
  };
}

// GET /api/assets
router.get(
  "/",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("assets")
      .select("*")
      .eq("user_id", req.user!.id)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, data: { assets: (data as AssetRow[]).map(toAsset) } });
  })
);

// POST /api/assets
router.post(
  "/",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = createAssetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Invalid asset payload" });
    }

    const input = parsed.data;
    const { data, error } = await supabaseAdmin
      .from("assets")
      .insert({
        user_id: req.user!.id,
        type: input.type,
        title: input.title,
        campaign_id: input.campaignId ?? null,
        persona_id: input.personaId ?? null,
        campaign_name: input.campaignName,
        persona_name: input.personaName,
        platform: input.platform,
        excerpt: input.excerpt ?? null,
      })
      .select("*")
      .single();

    if (error || !data) {
      return res.status(500).json({ success: false, message: error?.message || "Failed to create asset" });
    }

    return res.status(201).json({ success: true, data: { asset: toAsset(data as AssetRow) } });
  })
);

// DELETE /api/assets/:id
router.delete(
  "/:id",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("assets")
      .delete()
      .eq("user_id", req.user!.id)
      .eq("id", req.params.id)
      .select("id")
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Asset not found" });
    return res.json({ success: true, message: "Asset deleted" });
  })
);

export default router;

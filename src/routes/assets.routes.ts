import { Router } from "express";
import multer from "multer";
import { supabaseAdmin } from "../config/supabase";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import { createAssetSchema, updateAssetSchema } from "../schemas/asset.schema";

const router = Router();
const ASSETS_BUCKET = "assets";

const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

type AssetRow = {
  id: string;
  user_id: string;
  campaign_id: string | null;
  persona_id: string | null;
  type: "image" | "copy" | "video" | "pdf";
  title: string;
  campaign_name: string;
  persona_name: string;
  platform: string;
  excerpt: string | null;
  file_url: string | null;
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
    fileUrl: row.file_url ?? undefined,
    campaignId: row.campaign_id,
    personaId: row.persona_id,
  };
}

function assetTypeFromMime(mime: string): "image" | "video" | "pdf" | "copy" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return "copy";
}

function extensionFromMime(mime: string, originalName: string): string {
  const fromName = originalName.includes(".") ? originalName.split(".").pop() : "";
  if (fromName && fromName.length <= 8) return fromName.toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "application/pdf": "pdf",
    "text/plain": "txt",
  };
  return map[mime] ?? "bin";
}

// GET /api/assets
router.get(
  "/",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "12"), 10) || 12));
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const type = typeof req.query.type === "string" ? req.query.type.trim() : "";
    const platform = typeof req.query.platform === "string" ? req.query.platform.trim() : "";
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabaseAdmin
      .from("assets")
      .select("*", { count: "exact" })
      .eq("user_id", req.user!.id);

    if (type && type !== "all") {
      query = query.eq("type", type);
    }
    if (platform) {
      query = query.eq("platform", platform);
    }
    if (search) {
      query = query.or(`title.ilike.*${search}*,campaign_name.ilike.*${search}*`);
    }

    const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);

    if (error) return res.status(500).json({ success: false, message: error.message });

    const total = count ?? 0;
    return res.json({
      success: true,
      data: {
        assets: ((data as AssetRow[]) ?? []).map(toAsset),
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      },
    });
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

// POST /api/assets/upload — multipart file upload
router.post(
  "/upload",
  authenticateToken,
  assetUpload.single("file"),
  asyncHandler(async (req: AuthRequest, res) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, message: "A file is required" });
    }

    const title =
      (typeof req.body?.title === "string" && req.body.title.trim()) ||
      file.originalname ||
      "Untitled asset";
    const campaignName = typeof req.body?.campaignName === "string" ? req.body.campaignName : "";
    const personaName = typeof req.body?.personaName === "string" ? req.body.personaName : "";
    const platform = typeof req.body?.platform === "string" ? req.body.platform : "";
    const type = assetTypeFromMime(file.mimetype);
    const ext = extensionFromMime(file.mimetype, file.originalname);
    const path = `${req.user!.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(ASSETS_BUCKET)
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });

    if (uploadError) {
      return res.status(500).json({ success: false, message: uploadError.message });
    }

    const { data: publicUrlData } = supabaseAdmin.storage.from(ASSETS_BUCKET).getPublicUrl(path);
    const fileUrl = publicUrlData.publicUrl;

    const { data, error } = await supabaseAdmin
      .from("assets")
      .insert({
        user_id: req.user!.id,
        type,
        title,
        campaign_name: campaignName,
        persona_name: personaName,
        platform,
        file_url: fileUrl,
        excerpt: type === "copy" ? file.buffer.toString("utf8").slice(0, 500) : null,
      })
      .select("*")
      .single();

    if (error || !data) {
      return res.status(500).json({ success: false, message: error?.message || "Failed to save asset" });
    }

    return res.status(201).json({ success: true, data: { asset: toAsset(data as AssetRow) } });
  })
);

// PATCH /api/assets/:id
router.patch(
  "/:id",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = updateAssetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Invalid asset payload" });
    }

    const updates: Record<string, unknown> = {};
    if (parsed.data.title !== undefined) updates.title = parsed.data.title;
    if (parsed.data.platform !== undefined) updates.platform = parsed.data.platform;
    if (parsed.data.excerpt !== undefined) updates.excerpt = parsed.data.excerpt;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    const { data, error } = await supabaseAdmin
      .from("assets")
      .update(updates)
      .eq("user_id", req.user!.id)
      .eq("id", String(req.params.id))
      .select("*")
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Asset not found" });
    return res.json({ success: true, data: { asset: toAsset(data as AssetRow) } });
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
      .eq("id", String(req.params.id))
      .select("id")
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Asset not found" });
    return res.json({ success: true, message: "Asset deleted" });
  })
);

export default router;

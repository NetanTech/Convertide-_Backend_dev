import { Router } from "express";
import { supabaseAdmin } from "../config/supabase";
import { authenticateToken } from "../middleware/auth";
import { attachBusinessContext, type BusinessAuthRequest } from "../middleware/businessContext";
import { asyncHandler } from "../middleware/errorHandler";
import {
  createCampaignSchema,
  publishCampaignSchema,
  publishPreviewQuerySchema,
  updateCampaignSchema,
} from "../schemas/campaign.schema";
import { buildCampaignPayload } from "../services/generators";
import { createNotification } from "../services/notifications";
import { consumeCredits, CREDIT_COSTS, InsufficientCreditsError } from "../services/billing";
import { ensureUserSettings } from "../services/settings";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
} from "../services/idempotency";
import {
  buildPublishPreview,
  executePublish,
  listPublishes,
  revokePublish,
} from "../services/campaignPublish";
import { logAccountAudit } from "../services/accountAudit";

const router = Router();

function paramId(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

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
  const stats = (row.stats ?? {}) as Record<string, unknown>;
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
    targetChannels: Array.isArray(stats.targetChannels)
      ? (stats.targetChannels as string[])
      : [],
    stats: row.stats,
    tabs: row.tabs,
  };
}

/** Attach selected library assets to a newly created campaign. */
async function linkAssetsToCampaign(
  userId: string,
  businessId: string,
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
    .eq("business_id", businessId)
    .in("id", assetIds);
}

// GET /api/campaigns
router.get(
  "/",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
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
      .eq("user_id", req.user!.id).eq("business_id", req.businessId!);

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
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "personaId is required" });
    }

    const clientRequestId = parsed.data.clientRequestId?.trim();
    if (clientRequestId) {
      const claim = await claimIdempotencyKey({
        userId: req.user!.id,
        businessId: req.businessId,
        scope: "campaign_generate",
        requestKey: clientRequestId,
      });

      if (claim.kind === "completed") {
        const cached = claim.response?.campaign;
        if (cached) {
          return res.status(200).json({
            success: true,
            data: { campaign: cached, replayed: true },
          });
        }
        if (claim.resourceId) {
          const { data: existing } = await supabaseAdmin
            .from("campaigns")
            .select("*")
            .eq("user_id", req.user!.id)
            .eq("business_id", req.businessId!)
            .eq("id", claim.resourceId)
            .maybeSingle();
          if (existing) {
            return res.status(200).json({
              success: true,
              data: { campaign: toCampaign(existing as CampaignRow), replayed: true },
            });
          }
        }
      }

      if (claim.kind === "processing") {
        return res.status(409).json({
          success: false,
          message: "Campaign generation already in progress for this request. Retry shortly.",
        });
      }

      if (claim.kind === "failed") {
        return res.status(409).json({
          success: false,
          message: claim.message || "Previous generation failed. Use a new clientRequestId to retry.",
        });
      }
    }

    const { data: persona, error: personaError } = await supabaseAdmin
      .from("personas")
      .select(
        "id, name, demographics, psychographics, pain_points, goals, buying_triggers"
      )
      .eq("user_id", req.user!.id).eq("business_id", req.businessId!)
      .eq("id", parsed.data.personaId)
      .maybeSingle();

    if (personaError) {
      if (clientRequestId) {
        await failIdempotencyKey({
          userId: req.user!.id,
          scope: "campaign_generate",
          requestKey: clientRequestId,
          message: personaError.message,
        });
      }
      return res.status(500).json({ success: false, message: personaError.message });
    }
    if (!persona) {
      if (clientRequestId) {
        await failIdempotencyKey({
          userId: req.user!.id,
          scope: "campaign_generate",
          requestKey: clientRequestId,
          message: "Persona not found",
        });
      }
      return res.status(404).json({ success: false, message: "Persona not found" });
    }

    let payload: Awaited<ReturnType<typeof buildCampaignPayload>>;
    try {
      const aiPrefs = (await ensureUserSettings(req.user!.id)).ai;
      payload = await buildCampaignPayload(
        req.user!.id,
        {
          id: persona.id,
          name: persona.name,
          demographics: persona.demographics,
          psychographics: persona.psychographics,
          pain_points: persona.pain_points,
          goals: persona.goals,
          buying_triggers: persona.buying_triggers,
        },
        parsed.data.name,
        parsed.data.durationDays,
        aiPrefs,
        parsed.data.channels
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Campaign generation failed";
      if (clientRequestId) {
        await failIdempotencyKey({
          userId: req.user!.id,
          scope: "campaign_generate",
          requestKey: clientRequestId,
          message,
        });
      }
      throw err;
    }

    const { data, error } = await supabaseAdmin
      .from("campaigns")
      .insert({
        user_id: req.user!.id,
        business_id: req.businessId,
        ...payload,
      })
      .select("*")
      .single();

    if (error || !data) {
      const message = error?.message || "Failed to create campaign";
      if (clientRequestId) {
        await failIdempotencyKey({
          userId: req.user!.id,
          scope: "campaign_generate",
          requestKey: clientRequestId,
          message,
        });
      }
      return res.status(500).json({ success: false, message });
    }

    // Charge only after the campaign row exists so failed attempts never create dupes or bill twice.
    try {
      await consumeCredits(req.user!.id, CREDIT_COSTS.campaign, "campaign_generate", req.businessId);
    } catch (err) {
      await supabaseAdmin.from("campaigns").delete().eq("id", (data as CampaignRow).id);
      const message =
        err instanceof InsufficientCreditsError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Credit charge failed";
      if (clientRequestId) {
        await failIdempotencyKey({
          userId: req.user!.id,
          scope: "campaign_generate",
          requestKey: clientRequestId,
          message,
        });
      }
      if (err instanceof InsufficientCreditsError) {
        return res.status(402).json({ success: false, message: err.message });
      }
      throw err;
    }

    const campaign = toCampaign(data as CampaignRow);

    if (clientRequestId) {
      await completeIdempotencyKey({
        userId: req.user!.id,
        scope: "campaign_generate",
        requestKey: clientRequestId,
        resourceId: campaign.id,
        response: { campaign },
      });
    }

    await linkAssetsToCampaign(
      req.user!.id,
      req.businessId!,
      campaign.id,
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
      actionHref: `/dashboard/campaigns/${campaign.id}`,
      actionTone: "primary",
    });

    await logAccountAudit({
      userId: req.user!.id,
      businessId: req.businessId,
      action: "campaign.generate",
      actor: "user",
      reference: campaign.id,
      metadata: { clientRequestId: clientRequestId || null, name: campaign.name },
    });

    return res.status(201).json({ success: true, data: { campaign } });
  })
);

// POST /api/campaigns/draft � save without AI generation / credit spend
router.post(
  "/draft",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "personaId is required" });
    }

    const { data: persona, error: personaError } = await supabaseAdmin
      .from("personas")
      .select("id, name")
      .eq("user_id", req.user!.id).eq("business_id", req.businessId!)
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
        business_id: req.businessId,
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
          targetChannels: parsed.data.channels ?? [],
          platforms: [],
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
      req.businessId!,
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
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("campaigns")
      .select("*")
      .eq("user_id", req.user!.id).eq("business_id", req.businessId!)
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
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const { data: original, error: fetchError } = await supabaseAdmin
      .from("campaigns")
      .select("*")
      .eq("user_id", req.user!.id).eq("business_id", req.businessId!)
      .eq("id", req.params.id)
      .maybeSingle();

    if (fetchError) return res.status(500).json({ success: false, message: fetchError.message });
    if (!original) return res.status(404).json({ success: false, message: "Campaign not found" });

    const source = original as CampaignRow;
    const { data: created, error: insertError } = await supabaseAdmin
      .from("campaigns")
      .insert({
        user_id: req.user!.id,
        business_id: req.businessId,
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
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
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
      .eq("user_id", req.user!.id).eq("business_id", req.businessId!)
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
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("campaigns")
      .delete()
      .eq("user_id", req.user!.id).eq("business_id", req.businessId!)
      .eq("id", req.params.id)
      .select("id")
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Campaign not found" });
    return res.json({ success: true, message: "Campaign deleted" });
  })
);

// GET /api/campaigns/:id/publish/preview?platform=meta|google_ads|email
router.get(
  "/:id/publish/preview",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const parsed = publishPreviewQuerySchema.safeParse({
      platform: req.query.platform ?? "meta",
    });
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "platform must be meta, google_ads, or email",
      });
    }

    try {
      const preview = await buildPublishPreview({
        userId: req.user!.id,
        businessId: req.businessId!,
        campaignId: paramId(req.params.id),
        platform: parsed.data.platform,
        userEmail: req.user!.email ?? null,
      });
      return res.json({ success: true, data: { preview } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Preview failed";
      if (/not found/i.test(message)) {
        return res.status(404).json({ success: false, message });
      }
      return res.status(400).json({ success: false, message });
    }
  })
);

// POST /api/campaigns/:id/publish
router.post(
  "/:id/publish",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const parsed = publishCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "platform, previewToken, and clientRequestId are required",
      });
    }

    const campaignId = paramId(req.params.id);
    const idemKey = `${campaignId}:${parsed.data.platform}:${parsed.data.clientRequestId}`;

    const claim = await claimIdempotencyKey({
      userId: req.user!.id,
      businessId: req.businessId,
      scope: "campaign_publish",
      requestKey: idemKey,
    });

    if (claim.kind === "completed" && claim.response?.publish) {
      return res.status(200).json({
        success: true,
        data: { publish: claim.response.publish, replayed: true },
      });
    }
    if (claim.kind === "processing") {
      return res.status(409).json({
        success: false,
        message: "Publish already in progress for this request. Retry shortly.",
      });
    }

    try {
      if (parsed.data.platform === "email" && !(parsed.data.recipients?.length)) {
        return res.status(400).json({
          success: false,
          message: "recipients are required for email publish (max 50).",
        });
      }

      const result = await executePublish({
        userId: req.user!.id,
        businessId: req.businessId!,
        campaignId,
        platform: parsed.data.platform,
        previewToken: parsed.data.previewToken,
        idempotencyKey: parsed.data.clientRequestId,
        userEmail: req.user!.email ?? null,
        recipients: parsed.data.recipients,
      });

      await completeIdempotencyKey({
        userId: req.user!.id,
        scope: "campaign_publish",
        requestKey: idemKey,
        resourceId: result.publish.id,
        response: { publish: result.publish },
      });

      return res.status(result.replayed ? 200 : 201).json({
        success: true,
        data: { publish: result.publish, replayed: result.replayed ?? false },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Publish failed";
      await failIdempotencyKey({
        userId: req.user!.id,
        scope: "campaign_publish",
        requestKey: idemKey,
        message,
      });
      if (/not found/i.test(message)) {
        return res.status(404).json({ success: false, message });
      }
      if (/preview|connect|authorized|expired|token/i.test(message)) {
        return res.status(400).json({ success: false, message });
      }
      if (/in progress/i.test(message)) {
        return res.status(409).json({ success: false, message });
      }
      return res.status(500).json({ success: false, message });
    }
  })
);

// GET /api/campaigns/:id/publishes
router.get(
  "/:id/publishes",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    try {
      const publishes = await listPublishes({
        userId: req.user!.id,
        businessId: req.businessId!,
        campaignId: paramId(req.params.id),
      });
      return res.json({ success: true, data: { publishes } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list publishes";
      return res.status(500).json({ success: false, message });
    }
  })
);

// POST /api/campaigns/:id/publishes/:publishId/revoke
router.post(
  "/:id/publishes/:publishId/revoke",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    try {
      const result = await revokePublish({
        userId: req.user!.id,
        businessId: req.businessId!,
        campaignId: paramId(req.params.id),
        publishId: paramId(req.params.publishId),
      });
      return res.json({ success: true, data: { publish: result } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Revoke failed";
      if (/not found/i.test(message)) {
        return res.status(404).json({ success: false, message });
      }
      return res.status(400).json({ success: false, message });
    }
  })
);

export default router;

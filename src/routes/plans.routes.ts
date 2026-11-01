import { Router } from "express";
import { supabaseAdmin } from "../config/supabase";
import { authenticateToken } from "../middleware/auth";
import { attachBusinessContext, type BusinessAuthRequest } from "../middleware/businessContext";
import { asyncHandler } from "../middleware/errorHandler";
import { createPlanSchema, updatePlanSchema } from "../schemas/plan.schema";
import { buildPlanPayload } from "../services/generators";
import { createNotification } from "../services/notifications";
import { consumeCredits, CREDIT_COSTS, InsufficientCreditsError } from "../services/billing";
import { ensureUserSettings } from "../services/settings";
import { maybeAutoSaveAiCopy } from "../services/autoSaveAssets";
import {
  getPlanVersion,
  isContentRevision,
  listPlanVersions,
  savePlanVersion,
  updatesFromPlanSnapshot,
} from "../services/planVersions";

const router = Router();

type PlanRow = {
  id: string;
  user_id: string;
  persona_id: string | null;
  campaign_id: string | null;
  name: string;
  status: "Active" | "Draft" | "Completed";
  persona_snapshot: { name: string; meta: string };
  campaign_snapshot: { name: string; meta: string };
  budget: string;
  timeline: { duration: string; range: string };
  channel_mix: unknown[];
  weekly_action_plan: unknown[];
  content_calendar: unknown[];
  kpis: unknown[];
  expected_outcome: unknown[];
  progress: number | null;
  created_at: string;
  updated_at: string | null;
};

function toPlan(row: PlanRow) {
  return {
    id: row.id,
    personaId: row.persona_id,
    campaignId: row.campaign_id,
    name: row.name,
    status: row.status,
    generatedAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    persona: row.persona_snapshot,
    campaign: row.campaign_snapshot,
    budget: row.budget,
    timeline: row.timeline,
    channelMix: row.channel_mix,
    weeklyActionPlan: row.weekly_action_plan,
    contentCalendar: row.content_calendar,
    kpis: row.kpis,
    expectedOutcome: row.expected_outcome,
    progress: row.progress ?? 0,
  };
}

// GET /api/plans
router.get(
  "/",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "8"), 10) || 8));
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const personaName = typeof req.query.personaName === "string" ? req.query.personaName.trim() : "";
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabaseAdmin
      .from("plans")
      .select("*", { count: "exact" })
      .eq("user_id", req.user!.id).eq("business_id", req.businessId!);

    if (status && status !== "all") {
      query = query.eq("status", status);
    }
    if (personaName) {
      query = query.eq("persona_snapshot->>name", personaName);
    }
    if (search) {
      query = query.or(`name.ilike.*${search}*,persona_snapshot->>name.ilike.*${search}*`);
    }

    const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);

    if (error) return res.status(500).json({ success: false, message: error.message });

    const total = count ?? 0;
    return res.json({
      success: true,
      data: {
        plans: (data as PlanRow[]).map(toPlan),
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      },
    });
  })
);

// POST /api/plans/generate
router.post(
  "/generate",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const parsed = createPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "personaId is required" });
    }

    const { data: persona, error: personaError } = await supabaseAdmin
      .from("personas")
      .select("id, name, demographics")
      .eq("user_id", req.user!.id).eq("business_id", req.businessId!)
      .eq("id", parsed.data.personaId)
      .maybeSingle();

    if (personaError) return res.status(500).json({ success: false, message: personaError.message });
    if (!persona) return res.status(404).json({ success: false, message: "Persona not found" });

    let campaign: { id: string; name: string } | null = null;
    if (parsed.data.campaignId) {
      const { data: campaignRow, error: campaignError } = await supabaseAdmin
        .from("campaigns")
        .select("id, name")
        .eq("user_id", req.user!.id).eq("business_id", req.businessId!)
        .eq("id", parsed.data.campaignId)
        .maybeSingle();

      if (campaignError) return res.status(500).json({ success: false, message: campaignError.message });
      if (!campaignRow) return res.status(404).json({ success: false, message: "Campaign not found" });
      campaign = campaignRow;
    }

    try {
      await consumeCredits(req.user!.id, CREDIT_COSTS.plan, "plan_generate", req.businessId);
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return res.status(402).json({ success: false, message: err.message });
      }
      throw err;
    }

    const aiPrefs = (await ensureUserSettings(req.user!.id)).ai;
    const payload = await buildPlanPayload({
      userId: req.user!.id,
      persona: { id: persona.id, name: persona.name, demographics: persona.demographics },
      campaign,
      name: parsed.data.name,
      budget: parsed.data.budget,
      durationDays: parsed.data.durationDays,
      aiPrefs,
    });

    const { data, error } = await supabaseAdmin
      .from("plans")
      .insert({
        user_id: req.user!.id,
        business_id: req.businessId,
        ...payload,
      })
      .select("*")
      .single();

    if (error || !data) {
      return res.status(500).json({ success: false, message: error?.message || "Failed to create plan" });
    }

    const weekOne = Array.isArray(payload.weekly_action_plan) ? payload.weekly_action_plan[0] : null;
    const weekTasks =
      weekOne && typeof weekOne === "object" && Array.isArray((weekOne as { tasks?: unknown }).tasks)
        ? ((weekOne as { tasks: string[] }).tasks)
        : [];
    await maybeAutoSaveAiCopy(req.user!.id, {
      title: `Plan — ${payload.name}`,
      excerpt: [`Budget: ${payload.budget}`, `Timeline: ${payload.timeline.duration}`, ...weekTasks]
        .filter(Boolean)
        .join("\n"),
      personaId: persona.id,
      personaName: persona.name,
      campaignId: campaign?.id ?? null,
      campaignName: campaign?.name ?? "",
      platform: "Plan",
    });

    await createNotification(req.user!.id, {
      category: "ai",
      title: "Marketing Plan Ready",
      description: `${payload.name} is ready. Review timeline, channel mix, and weekly actions.`,
      actionLabel: "View Plan",
      actionHref: `/dashboard/plans/${data.id}`,
      actionTone: "insight",
    });

    return res.status(201).json({ success: true, data: { plan: toPlan(data as PlanRow) } });
  })
);

// GET /api/plans/:id
router.get(
  "/:id",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("plans")
      .select("*")
      .eq("user_id", req.user!.id).eq("business_id", req.businessId!)
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Plan not found" });
    return res.json({ success: true, data: { plan: toPlan(data as PlanRow) } });
  })
);

// GET /api/plans/:id/versions
router.get(
  "/:id/versions",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const planId = String(req.params.id);
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("plans")
      .select("id")
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!)
      .eq("id", planId)
      .maybeSingle();

    if (fetchError) return res.status(500).json({ success: false, message: fetchError.message });
    if (!existing) return res.status(404).json({ success: false, message: "Plan not found" });

    try {
      const versions = await listPlanVersions(req.user!.id, planId);
      return res.json({ success: true, data: { versions } });
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : "Could not load versions",
      });
    }
  })
);

// POST /api/plans/:id/versions/:versionId/restore
router.post(
  "/:id/versions/:versionId/restore",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const planId = String(req.params.id);
    const versionId = String(req.params.versionId);
    const body = (req.body ?? {}) as {
      confirmResetProgress?: unknown;
      keepCurrentProgress?: unknown;
    };
    const confirmResetProgress = Boolean(body.confirmResetProgress);
    const keepCurrentProgress = Boolean(body.keepCurrentProgress);

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("plans")
      .select("*")
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!)
      .eq("id", planId)
      .maybeSingle();

    if (fetchError) return res.status(500).json({ success: false, message: fetchError.message });
    if (!existing) return res.status(404).json({ success: false, message: "Plan not found" });

    const version = await getPlanVersion(req.user!.id, planId, versionId);
    if (!version) {
      return res.status(404).json({ success: false, message: "Version not found" });
    }

    const currentProgress = Number((existing as PlanRow).progress ?? 0);
    const snapshotProgress = Number(version.snapshot.progress ?? 0);
    const wouldResetProgress = currentProgress > 0 && snapshotProgress < currentProgress;

    if (wouldResetProgress && !confirmResetProgress && !keepCurrentProgress) {
      return res.status(409).json({
        success: false,
        code: "CONFIRM_RESET_PROGRESS",
        message:
          "Restoring this version would reduce completed progress. Confirm to reset progress, or keep your current progress.",
        data: {
          currentProgress,
          restoredProgress: snapshotProgress,
        },
      });
    }

    try {
      await savePlanVersion({
        userId: req.user!.id,
        planId,
        row: existing as Record<string, unknown>,
        reason: "restore",
      });
    } catch (err) {
      console.warn("[plan-versions] snapshot before restore failed", err);
    }

    const updates = updatesFromPlanSnapshot(
      version.snapshot,
      keepCurrentProgress || (wouldResetProgress && !confirmResetProgress)
        ? { preserveProgress: currentProgress }
        : undefined
    );

    const { data, error } = await supabaseAdmin
      .from("plans")
      .update(updates)
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!)
      .eq("id", planId)
      .select("*")
      .single();

    if (error || !data) {
      return res.status(500).json({
        success: false,
        message: error?.message || "Failed to restore plan version",
      });
    }

    return res.json({
      success: true,
      message: `Restored version ${version.versionNumber}`,
      data: { plan: toPlan(data as PlanRow) },
    });
  })
);

// POST /api/plans/:id/duplicate
router.post(
  "/:id/duplicate",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const { data: original, error: fetchError } = await supabaseAdmin
      .from("plans")
      .select("*")
      .eq("user_id", req.user!.id).eq("business_id", req.businessId!)
      .eq("id", req.params.id)
      .maybeSingle();

    if (fetchError) return res.status(500).json({ success: false, message: fetchError.message });
    if (!original) return res.status(404).json({ success: false, message: "Plan not found" });

    const source = original as PlanRow;
    const { data: created, error: insertError } = await supabaseAdmin
      .from("plans")
      .insert({
        user_id: req.user!.id,
        business_id: req.businessId,
        persona_id: source.persona_id,
        campaign_id: source.campaign_id,
        name: `${source.name} (Copy)`,
        status: "Draft",
        persona_snapshot: source.persona_snapshot,
        campaign_snapshot: source.campaign_snapshot,
        budget: source.budget,
        timeline: source.timeline,
        channel_mix: source.channel_mix,
        weekly_action_plan: source.weekly_action_plan,
        content_calendar: source.content_calendar,
        kpis: source.kpis,
        expected_outcome: source.expected_outcome,
        progress: 0,
      })
      .select("*")
      .single();

    if (insertError || !created) {
      return res.status(500).json({ success: false, message: insertError?.message || "Failed to duplicate plan" });
    }

    return res.status(201).json({ success: true, data: { plan: toPlan(created as PlanRow) } });
  })
);

// PATCH /api/plans/:id
router.patch(
  "/:id",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const parsed = updatePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Invalid plan update" });
    }

    const planId = String(req.params.id);
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("plans")
      .select("*")
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!)
      .eq("id", planId)
      .maybeSingle();

    if (fetchError) return res.status(500).json({ success: false, message: fetchError.message });
    if (!existing) return res.status(404).json({ success: false, message: "Plan not found" });

    const body = parsed.data;
    const currentProgress = Number((existing as PlanRow).progress ?? 0);
    const contentRevision = isContentRevision(body as Record<string, unknown>);

    // Lowering progress (resetting completed work) requires explicit confirmation.
    if (body.progress !== undefined && body.progress < currentProgress && !body.confirmResetProgress) {
      return res.status(409).json({
        success: false,
        code: "CONFIRM_RESET_PROGRESS",
        message:
          "This update would reduce completed progress. Confirm to reset completed work, or leave progress unchanged.",
        data: { currentProgress, requestedProgress: body.progress },
      });
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (body.name !== undefined) updates.name = body.name;
    if (body.status !== undefined) updates.status = body.status;
    if (body.budget !== undefined) updates.budget = body.budget;
    if (body.timeline !== undefined) updates.timeline = body.timeline;
    if (body.channelMix !== undefined) updates.channel_mix = body.channelMix;
    if (body.weeklyActionPlan !== undefined) updates.weekly_action_plan = body.weeklyActionPlan;
    if (body.contentCalendar !== undefined) updates.content_calendar = body.contentCalendar;
    if (body.kpis !== undefined) updates.kpis = body.kpis;
    if (body.expectedOutcome !== undefined) updates.expected_outcome = body.expectedOutcome;
    if (body.progress !== undefined) {
      updates.progress = body.progress;
    } else if (contentRevision) {
      // Content revisions never wipe progress unless the client explicitly sets it.
      updates.progress = currentProgress;
    }

    if (contentRevision || (body.progress !== undefined && body.progress !== currentProgress)) {
      try {
        await savePlanVersion({
          userId: req.user!.id,
          planId,
          row: existing as Record<string, unknown>,
          reason: "edit",
        });
      } catch (err) {
        console.warn("[plan-versions] snapshot before edit failed", err);
      }
    }

    const { data, error } = await supabaseAdmin
      .from("plans")
      .update(updates)
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!)
      .eq("id", planId)
      .select("*")
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Plan not found" });
    return res.json({ success: true, data: { plan: toPlan(data as PlanRow) } });
  })
);

// DELETE /api/plans/:id
router.delete(
  "/:id",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("plans")
      .delete()
      .eq("user_id", req.user!.id).eq("business_id", req.businessId!)
      .eq("id", req.params.id)
      .select("id")
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Plan not found" });
    return res.json({ success: true, message: "Plan deleted" });
  })
);

export default router;

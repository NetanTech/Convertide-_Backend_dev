import { Router } from "express";
import { supabaseAdmin } from "../config/supabase";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import { createPlanSchema, updatePlanSchema } from "../schemas/plan.schema";
import { buildPlanPayload } from "../services/generators";
import { createNotification } from "../services/notifications";

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
  };
}

// GET /api/plans
router.get(
  "/",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("plans")
      .select("*")
      .eq("user_id", req.user!.id)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, data: { plans: (data as PlanRow[]).map(toPlan) } });
  })
);

// POST /api/plans/generate
router.post(
  "/generate",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = createPlanSchema.safeParse(req.body);
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

    let campaign: { id: string; name: string } | null = null;
    if (parsed.data.campaignId) {
      const { data: campaignRow, error: campaignError } = await supabaseAdmin
        .from("campaigns")
        .select("id, name")
        .eq("user_id", req.user!.id)
        .eq("id", parsed.data.campaignId)
        .maybeSingle();

      if (campaignError) return res.status(500).json({ success: false, message: campaignError.message });
      if (!campaignRow) return res.status(404).json({ success: false, message: "Campaign not found" });
      campaign = campaignRow;
    }

    const payload = buildPlanPayload({
      persona: { id: persona.id, name: persona.name, demographics: persona.demographics },
      campaign,
      name: parsed.data.name,
      budget: parsed.data.budget,
      durationDays: parsed.data.durationDays,
    });

    const { data, error } = await supabaseAdmin
      .from("plans")
      .insert({
        user_id: req.user!.id,
        ...payload,
      })
      .select("*")
      .single();

    if (error || !data) {
      return res.status(500).json({ success: false, message: error?.message || "Failed to create plan" });
    }

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
  asyncHandler(async (req: AuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("plans")
      .select("*")
      .eq("user_id", req.user!.id)
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Plan not found" });
    return res.json({ success: true, data: { plan: toPlan(data as PlanRow) } });
  })
);

// PATCH /api/plans/:id
router.patch(
  "/:id",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = updatePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Invalid plan update" });
    }

    const body = parsed.data;
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

    const { data, error } = await supabaseAdmin
      .from("plans")
      .update(updates)
      .eq("user_id", req.user!.id)
      .eq("id", req.params.id)
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
  asyncHandler(async (req: AuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("plans")
      .delete()
      .eq("user_id", req.user!.id)
      .eq("id", req.params.id)
      .select("id")
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Plan not found" });
    return res.json({ success: true, message: "Plan deleted" });
  })
);

export default router;

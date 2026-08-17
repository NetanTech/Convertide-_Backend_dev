import { Router } from "express";
import { supabaseAdmin } from "../config/supabase";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import { onboardingInputSchema } from "../schemas/persona.schema";
import { generatePersona } from "../services/personaGenerator";
import { createNotification } from "../services/notifications";
import { markOnboardingCompleted } from "../services/profile";

const router = Router();

type PersonaRow = {
  id: string;
  name: string;
  confidence: number;
  confidence_label: string;
  confidence_summary: string;
  demographics: { label: string; value: string }[];
  psychographics: string[];
  pain_points: string[];
  goals: string[];
  buying_triggers: string[];
  objections: string[];
  platform_preferences: string[];
  onboarding_input?: Record<string, unknown> | null;
  created_at: string;
  updated_at?: string | null;
};

// Maps the DB row (snake_case) to the shape the frontend already expects.
function toPersona(row: PersonaRow) {
  const timestamp = row.updated_at || row.created_at;

  return {
    id: row.id,
    status: "completed" as const,
    name: row.name,
    generatedAt: row.created_at,
    updatedAt: timestamp,
    formData: row.onboarding_input ?? {},
    confidence: row.confidence,
    confidenceLabel: row.confidence_label,
    confidenceSummary: row.confidence_summary,
    demographics: row.demographics,
    psychographics: row.psychographics,
    painPoints: row.pain_points,
    goals: row.goals,
    buyingTriggers: row.buying_triggers,
    objections: row.objections,
    platformPreferences: row.platform_preferences,
  };
}

// POST /api/personas/generate
router.post(
  "/generate",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsedInput = onboardingInputSchema.safeParse(req.body);
    if (!parsedInput.success) {
      return res.status(400).json({
        success: false,
        message: "Please complete all required fields before generating a persona.",
      });
    }

    const generated = await generatePersona(parsedInput.data);

    const { data, error } = await supabaseAdmin
      .from("personas")
      .insert({
        user_id: req.user!.id,
        name: generated.name,
        confidence: generated.confidence,
        confidence_label: generated.confidenceLabel,
        confidence_summary: generated.confidenceSummary,
        demographics: generated.demographics,
        psychographics: generated.psychographics,
        pain_points: generated.painPoints,
        goals: generated.goals,
        buying_triggers: generated.buyingTriggers,
        objections: generated.objections,
        platform_preferences: generated.platformPreferences,
        onboarding_input: parsedInput.data,
      })
      .select()
      .single();

    if (error || !data) {
      return res.status(500).json({ success: false, message: error?.message || "Failed to save persona" });
    }

    await markOnboardingCompleted(req.user!.id);

    await createNotification(req.user!.id, {
      category: "ai",
      title: "New Persona",
      description: `AI generated '${(data as PersonaRow).name}' persona based on your recent activity and audience engagement patterns.`,
      actionLabel: "Review Persona",
      actionHref: `/dashboard/personas/${(data as PersonaRow).id}`,
      actionTone: "insight",
    });

    return res.status(201).json({ success: true, data: { persona: toPersona(data as PersonaRow) } });
  })
);

// GET /api/personas
router.get(
  "/",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("personas")
      .select("*")
      .eq("user_id", req.user!.id)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.json({ success: true, data: { personas: (data as PersonaRow[]).map(toPersona) } });
  })
);

// GET /api/personas/:id
router.get(
  "/:id",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("personas")
      .select("*")
      .eq("user_id", req.user!.id)
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
    if (!data) {
      return res.status(404).json({ success: false, message: "Persona not found" });
    }

    return res.json({ success: true, data: { persona: toPersona(data as PersonaRow) } });
  })
);

// PATCH /api/personas/:id
router.patch(
  "/:id",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("personas")
      .select("*")
      .eq("user_id", req.user!.id)
      .eq("id", req.params.id)
      .maybeSingle();

    if (fetchError) {
      return res.status(500).json({ success: false, message: fetchError.message });
    }
    if (!existing) {
      return res.status(404).json({ success: false, message: "Persona not found" });
    }

    const body = req.body as Record<string, unknown>;
    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (Array.isArray(body.demographics)) updates.demographics = body.demographics;
    if (Array.isArray(body.psychographics)) updates.psychographics = body.psychographics;
    if (Array.isArray(body.painPoints)) updates.pain_points = body.painPoints;
    if (Array.isArray(body.goals)) updates.goals = body.goals;
    if (Array.isArray(body.buyingTriggers)) updates.buying_triggers = body.buyingTriggers;
    if (Array.isArray(body.objections)) updates.objections = body.objections;
    if (Array.isArray(body.platformPreferences)) updates.platform_preferences = body.platformPreferences;

    if (Object.keys(updates).length === 1) {
      return res.status(400).json({ success: false, message: "No editable fields provided." });
    }

    const { data, error } = await supabaseAdmin
      .from("personas")
      .update(updates)
      .eq("user_id", req.user!.id)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(500).json({ success: false, message: error?.message || "Failed to update persona" });
    }

    return res.json({ success: true, data: { persona: toPersona(data as PersonaRow) } });
  })
);

// POST /api/personas/:id/regenerate
router.post(
  "/:id/regenerate",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("personas")
      .select("*")
      .eq("user_id", req.user!.id)
      .eq("id", req.params.id)
      .maybeSingle();

    if (fetchError) {
      return res.status(500).json({ success: false, message: fetchError.message });
    }
    if (!existing) {
      return res.status(404).json({ success: false, message: "Persona not found" });
    }

    const parsedInput = onboardingInputSchema.safeParse((existing as PersonaRow).onboarding_input);
    if (!parsedInput.success) {
      return res.status(400).json({
        success: false,
        message: "This persona is missing generation input and cannot be regenerated.",
      });
    }

    const generated = await generatePersona(parsedInput.data);

    const { data, error } = await supabaseAdmin
      .from("personas")
      .update({
        name: generated.name,
        confidence: generated.confidence,
        confidence_label: generated.confidenceLabel,
        confidence_summary: generated.confidenceSummary,
        demographics: generated.demographics,
        psychographics: generated.psychographics,
        pain_points: generated.painPoints,
        goals: generated.goals,
        buying_triggers: generated.buyingTriggers,
        objections: generated.objections,
        platform_preferences: generated.platformPreferences,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", req.user!.id)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(500).json({ success: false, message: error?.message || "Failed to regenerate persona" });
    }

    return res.json({ success: true, data: { persona: toPersona(data as PersonaRow) } });
  })
);

export default router;

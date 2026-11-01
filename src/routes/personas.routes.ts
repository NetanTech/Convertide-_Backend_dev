import { Router } from "express";
import { supabaseAdmin } from "../config/supabase";
import { authenticateToken } from "../middleware/auth";
import { attachBusinessContext, type BusinessAuthRequest } from "../middleware/businessContext";
import { asyncHandler } from "../middleware/errorHandler";
import { onboardingInputSchema } from "../schemas/persona.schema";
import { generatePersona } from "../services/personaGenerator";
import { createNotification } from "../services/notifications";
import { markOnboardingCompleted } from "../services/profile";
import { consumeCredits, CREDIT_COSTS, InsufficientCreditsError } from "../services/billing";
import { ensureUserSettings } from "../services/settings";
import { maybeAutoSaveAiCopy } from "../services/autoSaveAssets";
import {
  getPersonaVersion,
  listPersonaVersions,
  savePersonaVersion,
  updatesFromSnapshot,
} from "../services/personaVersions";
import { z } from "zod";
import {
  BusinessContextImportError,
  importBusinessContextFromUrl,
} from "../services/businessContextImport";
import { updateBusinessProfile } from "../services/businessProfiles";
import {
  listPersonaDependents,
  regeneratePersonaDependents,
} from "../services/personaDependents";

const router = Router();

const importContextSchema = z.object({
  url: z.string().min(1).max(2048),
  consent: z.literal(true),
  /** When true, empty business profile name/industry may be filled from import (never overwrites). */
  applyToBusinessProfile: z.boolean().optional(),
});

const regenerateDependentsSchema = z.object({
  confirm: z.literal(true),
  campaignIds: z.array(z.string().uuid()).max(50).optional(),
  planIds: z.array(z.string().uuid()).max(50).optional(),
});

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

// POST /api/personas/import-context — website business context (consent required)
router.post(
  "/import-context",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const parsed = importContextSchema.safeParse(req.body);
    if (!parsed.success) {
      const consentMissing = parsed.error.issues.some((i) => i.path.includes("consent"));
      return res.status(400).json({
        success: false,
        code: consentMissing ? "consent_required" : "invalid_url",
        message: consentMissing
          ? "Confirm consent to import public business details before continuing."
          : "Enter a valid website URL to import from.",
      });
    }

    try {
      const result = await importBusinessContextFromUrl({
        userId: req.user!.id,
        businessId: req.businessId!,
        url: parsed.data.url,
        consent: parsed.data.consent,
      });

      if (parsed.data.applyToBusinessProfile) {
        const patch: { name?: string; industry?: string } = {};
        // Only fill empty profile fields — never silently overwrite.
        const { data: profile } = await supabaseAdmin
          .from("business_profiles")
          .select("id, name, industry")
          .eq("id", req.businessId!)
          .eq("user_id", req.user!.id)
          .maybeSingle();

        if (profile) {
          const row = profile as { name?: string | null; industry?: string | null };
          if (result.fields.businessName && !String(row.name ?? "").trim()) {
            patch.name = result.fields.businessName;
          }
          if (result.fields.industry && !String(row.industry ?? "").trim()) {
            patch.industry = result.fields.industry;
          }
          if (Object.keys(patch).length > 0) {
            await updateBusinessProfile(req.user!.id, req.businessId!, patch);
          }
        }
      }

      return res.json({
        success: true,
        data: {
          import: result,
          recovery:
            result.partial
              ? "Partial import — review attributed fields, edit anything incorrect, then continue."
              : null,
        },
      });
    } catch (err) {
      if (err instanceof BusinessContextImportError) {
        const status =
          err.code === "consent_required"
            ? 403
            : err.code === "unreachable"
              ? 502
              : 400;
        return res.status(status).json({
          success: false,
          code: err.code,
          message: err.message,
          data: {
            recovery:
              err.code === "linkedin_unsupported"
                ? "Use your company website URL, or fill the form manually."
                : err.code === "invalid_url"
                  ? "Example: https://www.yourcompany.com"
                  : err.code === "unreachable" || err.code === "empty_page"
                    ? "Try another public page, or enter details manually."
                    : "You can skip import and continue with the form.",
          },
        });
      }
      throw err;
    }
  })
);

// POST /api/personas/generate
router.post(
  "/generate",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const parsedInput = onboardingInputSchema.safeParse(req.body);
    if (!parsedInput.success) {
      const detail =
        parsedInput.error.issues.find((issue) => issue.message)?.message ||
        "Please complete all required fields before generating a persona.";
      return res.status(400).json({
        success: false,
        message: detail,
      });
    }

    try {
      await consumeCredits(req.user!.id, CREDIT_COSTS.persona, "persona_generate", req.businessId);
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return res.status(402).json({ success: false, message: err.message });
      }
      throw err;
    }

    const aiPrefs = (await ensureUserSettings(req.user!.id)).ai;
    const generated = await generatePersona(req.user!.id, parsedInput.data, aiPrefs);

    const { data, error } = await supabaseAdmin
      .from("personas")
      .insert({
        user_id: req.user!.id,
        business_id: req.businessId,
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

    await maybeAutoSaveAiCopy(req.user!.id, {
      title: `Persona — ${generated.name}`,
      excerpt: [generated.confidenceSummary, ...generated.psychographics.slice(0, 3)].filter(Boolean).join("\n"),
      personaId: (data as PersonaRow).id,
      personaName: generated.name,
      platform: "Persona",
    });

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
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabaseAdmin
      .from("personas")
      .select("*", { count: "exact" })
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!);

    if (search) {
      query = query.ilike("name", `%${search}%`);
    }

    const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    const total = count ?? 0;
    return res.json({
      success: true,
      data: {
        personas: (data as PersonaRow[]).map(toPersona),
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      },
    });
  })
);

// GET /api/personas/:id
router.get(
  "/:id",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("personas")
      .select("*")
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!)
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

// GET /api/personas/:id/versions
router.get(
  "/:id/versions",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const personaId = String(req.params.id);
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("personas")
      .select("id")
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!)
      .eq("id", personaId)
      .maybeSingle();

    if (fetchError) {
      return res.status(500).json({ success: false, message: fetchError.message });
    }
    if (!existing) {
      return res.status(404).json({ success: false, message: "Persona not found" });
    }

    try {
      const versions = await listPersonaVersions(req.user!.id, personaId);
      return res.json({ success: true, data: { versions } });
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : "Could not load versions",
      });
    }
  })
);

// POST /api/personas/:id/versions/:versionId/restore
router.post(
  "/:id/versions/:versionId/restore",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const personaId = String(req.params.id);
    const versionId = String(req.params.versionId);

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("personas")
      .select("*")
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!)
      .eq("id", personaId)
      .maybeSingle();

    if (fetchError) {
      return res.status(500).json({ success: false, message: fetchError.message });
    }
    if (!existing) {
      return res.status(404).json({ success: false, message: "Persona not found" });
    }

    const version = await getPersonaVersion(req.user!.id, personaId, versionId);
    if (!version) {
      return res.status(404).json({ success: false, message: "Version not found" });
    }

    // Keep the live state before restoring so restore itself is reversible.
    await savePersonaVersion({
      userId: req.user!.id,
      personaId,
      row: existing as Record<string, unknown>,
      reason: "restore",
    });

    const { data, error } = await supabaseAdmin
      .from("personas")
      .update(updatesFromSnapshot(version.snapshot))
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!)
      .eq("id", personaId)
      .select("*")
      .single();

    if (error || !data) {
      return res.status(500).json({
        success: false,
        message: error?.message || "Failed to restore persona version",
      });
    }

    return res.json({
      success: true,
      message: `Restored version ${version.versionNumber}`,
      data: { persona: toPersona(data as PersonaRow) },
    });
  })
);

// POST /api/personas/:id/duplicate
router.post(
  "/:id/duplicate",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const { data: original, error: fetchError } = await supabaseAdmin
      .from("personas")
      .select("*")
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!)
      .eq("id", req.params.id)
      .maybeSingle();

    if (fetchError) return res.status(500).json({ success: false, message: fetchError.message });
    if (!original) return res.status(404).json({ success: false, message: "Persona not found" });

    const source = original as PersonaRow;
    const { data: created, error: insertError } = await supabaseAdmin
      .from("personas")
      .insert({
        user_id: req.user!.id,
        business_id: req.businessId,
        name: `${source.name} (Copy)`,
        confidence: source.confidence,
        confidence_label: source.confidence_label,
        confidence_summary: source.confidence_summary,
        demographics: source.demographics,
        psychographics: source.psychographics,
        pain_points: source.pain_points,
        goals: source.goals,
        buying_triggers: source.buying_triggers,
        objections: source.objections,
        platform_preferences: source.platform_preferences,
        onboarding_input: source.onboarding_input ?? null,
      })
      .select("*")
      .single();

    if (insertError || !created) {
      return res.status(500).json({ success: false, message: insertError?.message || "Failed to duplicate persona" });
    }

    return res.status(201).json({ success: true, data: { persona: toPersona(created as PersonaRow) } });
  })
);

// GET /api/personas/:id/dependents
router.get(
  "/:id/dependents",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const personaId = String(req.params.id);
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("personas")
      .select("id")
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!)
      .eq("id", personaId)
      .maybeSingle();

    if (fetchError) {
      return res.status(500).json({ success: false, message: fetchError.message });
    }
    if (!existing) {
      return res.status(404).json({ success: false, message: "Persona not found" });
    }

    try {
      const dependents = await listPersonaDependents({
        userId: req.user!.id,
        businessId: req.businessId!,
        personaId,
      });
      return res.json({ success: true, data: { dependents } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list dependents";
      return res.status(500).json({ success: false, message });
    }
  })
);

// POST /api/personas/:id/regenerate-dependents
router.post(
  "/:id/regenerate-dependents",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const parsed = regenerateDependentsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Confirm regeneration to update campaigns and plans linked to this persona.",
      });
    }

    const personaId = String(req.params.id);
    try {
      const result = await regeneratePersonaDependents({
        userId: req.user!.id,
        businessId: req.businessId!,
        personaId,
        campaignIds: parsed.data.campaignIds,
        planIds: parsed.data.planIds,
      });
      return res.json({ success: true, data: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to regenerate dependents";
      if (/not found/i.test(message)) {
        return res.status(404).json({ success: false, message });
      }
      return res.status(500).json({ success: false, message });
    }
  })
);

// PATCH /api/personas/:id
router.patch(
  "/:id",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("personas")
      .select("*")
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!)
      .eq("id", req.params.id)
      .maybeSingle();

    if (fetchError) {
      return res.status(500).json({ success: false, message: fetchError.message });
    }
    if (!existing) {
      return res.status(404).json({ success: false, message: "Persona not found" });
    }

    const body = req.body as Record<string, unknown>;
    const updates: Record<string, unknown> = {};

    if (Array.isArray(body.demographics)) updates.demographics = body.demographics;
    if (Array.isArray(body.psychographics)) updates.psychographics = body.psychographics;
    if (Array.isArray(body.painPoints)) updates.pain_points = body.painPoints;
    if (Array.isArray(body.goals)) updates.goals = body.goals;
    if (Array.isArray(body.buyingTriggers)) updates.buying_triggers = body.buyingTriggers;
    if (Array.isArray(body.objections)) updates.objections = body.objections;
    if (Array.isArray(body.platformPreferences)) updates.platform_preferences = body.platformPreferences;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: "No editable fields provided." });
    }

    try {
      await savePersonaVersion({
        userId: req.user!.id,
        personaId: String(req.params.id),
        row: existing as Record<string, unknown>,
        reason: "edit",
      });
    } catch (err) {
      console.warn("[persona-versions] snapshot before edit failed", err);
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from("personas")
      .update(updates)
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!)
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
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("personas")
      .select("*")
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!)
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

    try {
      await consumeCredits(req.user!.id, CREDIT_COSTS.persona, "persona_regenerate", req.businessId);
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return res.status(402).json({ success: false, message: err.message });
      }
      throw err;
    }

    const aiPrefs = (await ensureUserSettings(req.user!.id)).ai;
    const generated = await generatePersona(req.user!.id, parsedInput.data, aiPrefs);

    try {
      await savePersonaVersion({
        userId: req.user!.id,
        personaId: String(req.params.id),
        row: existing as Record<string, unknown>,
        reason: "regenerate",
      });
    } catch (err) {
      console.warn("[persona-versions] snapshot before regenerate failed", err);
    }

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
      .eq("business_id", req.businessId!)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(500).json({ success: false, message: error?.message || "Failed to regenerate persona" });
    }

    await maybeAutoSaveAiCopy(req.user!.id, {
      title: `Persona — ${generated.name} (regenerated)`,
      excerpt: [generated.confidenceSummary, ...generated.psychographics.slice(0, 3)].filter(Boolean).join("\n"),
      personaId: (data as PersonaRow).id,
      personaName: generated.name,
      platform: "Persona",
    });

    return res.json({ success: true, data: { persona: toPersona(data as PersonaRow) } });
  })
);

// DELETE /api/personas/:id
router.delete(
  "/:id",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("personas")
      .delete()
      .eq("user_id", req.user!.id)
      .eq("business_id", req.businessId!)
      .eq("id", req.params.id)
      .select("id")
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
    if (!data) {
      return res.status(404).json({ success: false, message: "Persona not found" });
    }

    return res.json({ success: true, message: "Persona deleted" });
  })
);

export default router;

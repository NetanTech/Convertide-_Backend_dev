import { z } from "zod";

export const createPlanSchema = z.object({
  personaId: z.string().uuid(),
  campaignId: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  budget: z.string().optional(),
  durationDays: z.number().int().positive().optional(),
});

export const updatePlanSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(["Active", "Draft", "Completed"]).optional(),
  budget: z.string().optional(),
  timeline: z
    .object({
      duration: z.string(),
      range: z.string(),
    })
    .optional(),
  channelMix: z
    .array(
      z.object({
        platform: z.enum(["instagram", "facebook", "email", "tiktok", "other"]),
        label: z.string(),
        percent: z.number(),
      })
    )
    .optional(),
  weeklyActionPlan: z
    .array(
      z.object({
        week: z.number(),
        days: z.string(),
        tasks: z.array(z.string()),
      })
    )
    .optional(),
  contentCalendar: z
    .array(
      z.object({
        platform: z.enum(["instagram", "facebook", "email", "tiktok", "other"]),
        label: z.string(),
        format: z.string(),
      })
    )
    .optional(),
  kpis: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        delta: z.string(),
        positive: z.boolean(),
      })
    )
    .optional(),
  expectedOutcome: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
      })
    )
    .optional(),
});

export type CreatePlanInput = z.infer<typeof createPlanSchema>;

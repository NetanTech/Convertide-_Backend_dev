import { z } from "zod";

const copyItemSchema = z.object({
  text: z.string(),
  score: z.number(),
  platform: z.string().optional(),
  personaId: z.string().optional(),
  format: z.string().optional(),
  angle: z.string().optional(),
  charLimit: z.number().optional(),
  charCount: z.number().optional(),
  withinLimit: z.boolean().optional(),
  feedback: z.string().optional(),
});

const tabSchema = z.object({
  label: z.string(),
  prefix: z.string(),
  platform: z.string().optional(),
  items: z.array(copyItemSchema),
});

export const createCampaignSchema = z.object({
  personaId: z.string().uuid(),
  name: z.string().min(1).optional(),
  durationDays: z.number().int().positive().optional(),
  assetIds: z.array(z.string().uuid()).max(50).optional(),
  channels: z.array(z.string().min(1).max(64)).max(20).optional(),
  /** Client-generated UUID; retries with the same key never create a second campaign. */
  clientRequestId: z.string().min(8).max(128).optional(),
});

export const publishCampaignSchema = z.object({
  platform: z.enum(["meta", "google_ads", "email"]),
  previewToken: z.string().min(16).max(2048),
  clientRequestId: z.string().min(8).max(128),
  /** Required for email publishes. Ignored for meta / google_ads. */
  recipients: z.array(z.string().email().max(254)).max(50).optional(),
});

export const publishPreviewQuerySchema = z.object({
  platform: z.enum(["meta", "google_ads", "email"]).default("meta"),
});

export const updateCampaignSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(["draft", "active", "completed"]).optional(),
  duration: z.number().int().positive().nullable().optional(),
  conversions: z
    .object({
      total: z.number(),
      rate: z.number(),
    })
    .optional(),
  stats: z
    .object({
      totalVariations: z.number(),
      headlines: z.number(),
      ctaVariations: z.number(),
      emotionalAngles: z.number(),
      readingScore: z.number(),
      readingScoreLabel: z.string(),
    })
    .optional(),
  tabs: z.array(tabSchema).optional(),
});

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

import { z } from "zod";

const copyItemSchema = z.object({
  text: z.string(),
  score: z.number(),
});

const tabSchema = z.object({
  label: z.string(),
  prefix: z.string(),
  items: z.array(copyItemSchema),
});

export const createCampaignSchema = z.object({
  personaId: z.string().uuid(),
  name: z.string().min(1).optional(),
});

export const updateCampaignSchema = z.object({
  name: z.string().min(1).optional(),
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

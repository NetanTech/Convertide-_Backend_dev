import { z } from "zod";

export const createAssetSchema = z.object({
  type: z.enum(["image", "copy", "video", "pdf"]),
  title: z.string().min(1),
  campaignId: z.string().uuid().optional(),
  personaId: z.string().uuid().optional(),
  campaignName: z.string().default(""),
  personaName: z.string().default(""),
  platform: z.string().default(""),
  excerpt: z.string().optional(),
});

export type CreateAssetInput = z.infer<typeof createAssetSchema>;

export const updateAssetSchema = z.object({
  title: z.string().min(1).optional(),
  platform: z.string().optional(),
  excerpt: z.string().optional(),
});

export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;

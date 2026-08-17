import { z } from "zod";

export const notificationPrefsSchema = z.object({
  personaGenerated: z.boolean(),
  campaignGenerated: z.boolean(),
  marketingPlanGenerated: z.boolean(),
  aiCreditsLow: z.boolean(),
  billingUpdates: z.boolean(),
  emailNotification: z.boolean(),
});

export const aiPrefsSchema = z.object({
  contentTone: z.string(),
  contentLength: z.string(),
  preferredLanguage: z.string(),
  autoSaveAiResults: z.boolean(),
});

export const settingsUpdateSchema = z
  .object({
    notifications: notificationPrefsSchema.partial().optional(),
    ai: aiPrefsSchema.partial().optional(),
  })
  .refine((value) => Boolean(value.notifications || value.ai), {
    message: "Provide notifications and/or ai preferences to update",
  });

export type SettingsUpdateInput = z.infer<typeof settingsUpdateSchema>;

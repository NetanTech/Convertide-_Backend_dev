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

export const securityPrefsSchema = z.object({
  /** Idle logout after this many minutes (5–120). */
  sessionTimeoutMinutes: z.number().int().min(5).max(120),
});

export const settingsUpdateSchema = z
  .object({
    notifications: notificationPrefsSchema.partial().optional(),
    ai: aiPrefsSchema.partial().optional(),
    security: securityPrefsSchema.partial().optional(),
  })
  .refine((value) => Boolean(value.notifications || value.ai || value.security), {
    message: "Provide notifications, ai, and/or security preferences to update",
  });

export type SettingsUpdateInput = z.infer<typeof settingsUpdateSchema>;

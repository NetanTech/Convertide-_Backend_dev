import { z } from "zod";

export const notificationCategorySchema = z.enum(["campaigns", "ai", "billing"]);
export const notificationToneSchema = z.enum(["primary", "warning", "insight", "neutral"]);

export const createNotificationSchema = z.object({
  category: notificationCategorySchema,
  title: z.string().min(1),
  description: z.string().min(1),
  actionLabel: z.string().default(""),
  actionHref: z.string().default(""),
  actionTone: notificationToneSchema.default("neutral"),
});

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>;

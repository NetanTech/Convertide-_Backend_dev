import { z } from "zod";

export const supportMessageSchema = z.object({
  body: z.string().trim().min(1, "Message is required").max(4000),
});

export const supportContactSchema = z.object({
  subject: z.string().trim().min(1, "Subject is required").max(200),
  message: z.string().trim().min(1, "Message is required").max(4000),
});

export type SupportMessageInput = z.infer<typeof supportMessageSchema>;
export type SupportContactInput = z.infer<typeof supportContactSchema>;

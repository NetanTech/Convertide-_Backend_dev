import { z } from "zod";

export const planTierIdSchema = z.enum(["pro", "scale", "enterprise"]);

export const changePlanSchema = z.object({
  planId: z.enum(["pro", "scale"]), // enterprise is "Talk to Sales", not self-serve
});

export const addPaymentMethodSchema = z.object({
  brand: z.enum(["visa", "mastercard"]),
  last4: z.string().regex(/^\d{4}$/, "last4 must be exactly 4 digits"),
  expiry: z.string().regex(/^(0[1-9]|1[0-2])\/\d{2}$/, "expiry must be in MM/YY format"),
  isPrimary: z.boolean().optional(),
});

export const updateBillingAddressSchema = z.object({
  company: z.string().optional().default(""),
  line1: z.string().min(1, "Address line 1 is required"),
  line2: z.string().optional().default(""),
  city: z.string().min(1, "City is required"),
  state: z.string().optional().default(""),
  postalCode: z.string().min(1, "Postal code is required"),
  country: z.string().min(1, "Country is required"),
});

export type ChangePlanInput = z.infer<typeof changePlanSchema>;
export type AddPaymentMethodInput = z.infer<typeof addPaymentMethodSchema>;
export type UpdateBillingAddressInput = z.infer<typeof updateBillingAddressSchema>;

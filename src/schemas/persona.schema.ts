import { z } from "zod";

export const onboardingInputSchema = z.object({
  businessName: z.string().min(1),
  industry: z.string().min(1),
  offerings: z.string().min(1),
  targetCustomers: z.array(z.string()).min(1),
  priceRange: z.string().min(1),
  marketingGoals: z.array(z.string()).min(1),
  challenges: z.array(z.string()).min(1),
});

export type OnboardingInput = z.infer<typeof onboardingInputSchema>;

// Shape the AI must return. Mirrors the frontend `Persona` type (minus id/generatedAt,
// which the server assigns) so the response can be stored and rendered as-is.
export const generatedPersonaSchema = z.object({
  name: z.string().describe("A short, brand-friendly persona name, e.g. 'Urban Glow Skincare Shopper'"),
  confidence: z.number().int().min(0).max(100),
  confidenceLabel: z.string().describe("e.g. 'High Confidence', 'Medium Confidence', 'Low Confidence'"),
  confidenceSummary: z.string().describe("1-2 sentence explanation of why this persona fits the business"),
  demographics: z
    .array(
      z.object({
        label: z.string().describe("e.g. 'Age', 'Gender', 'Location', 'Income', 'Education', 'Occupation'"),
        value: z.string(),
      })
    )
    .min(4)
    .max(8),
  psychographics: z.array(z.string()).min(3).max(8),
  painPoints: z.array(z.string()).min(3).max(8),
  goals: z.array(z.string()).min(3).max(8),
  buyingTriggers: z.array(z.string()).min(3).max(8),
  objections: z.array(z.string()).min(3).max(8),
  platformPreferences: z.array(z.string()).min(3).max(8),
});

export type GeneratedPersona = z.infer<typeof generatedPersonaSchema>;

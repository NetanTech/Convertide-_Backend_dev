import { z } from "zod";
import { gemini, GEMINI_MODEL } from "../config/gemini";
import { generatedPersonaSchema, type GeneratedPersona, type OnboardingInput } from "../schemas/persona.schema";
import type { AiPrefs } from "./settings";
import { buildAiPreferenceInstructions } from "./aiPrefs";

const responseJsonSchema = z.toJSONSchema(generatedPersonaSchema);

function buildPrompt(input: OnboardingInput, aiPrefs?: AiPrefs): string {
  return `You are a senior marketing strategist. Build one detailed, realistic customer persona for the
business described below. Ground every field in the business details given - do not invent an
unrelated audience.

Business name: ${input.businessName}
Industry: ${input.industry}
Products/services offered: ${input.offerings}
Target customers (business's own description): ${input.targetCustomers.join(", ")}
Average price range: ${input.priceRange}
Current marketing goals: ${input.marketingGoals.join(", ")}
Current challenges: ${input.challenges.join(", ")}

Return a single persona that a marketing team could immediately use to write ad copy and choose
channels. Be specific and concrete (real-sounding numbers, habits, and phrases) rather than generic.${buildAiPreferenceInstructions(
    aiPrefs ?? {
      contentTone: "",
      contentLength: "",
      preferredLanguage: "",
      autoSaveAiResults: true,
    }
  )}`;
}

export async function generatePersona(
  input: OnboardingInput,
  aiPrefs?: AiPrefs
): Promise<GeneratedPersona> {
  const response = await gemini.models.generateContent({
    model: GEMINI_MODEL,
    contents: buildPrompt(input, aiPrefs),
    config: {
      responseMimeType: "application/json",
      responseJsonSchema,
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned invalid JSON");
  }

  const result = generatedPersonaSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Gemini response did not match the persona schema: ${result.error.message}`);
  }

  return result.data;
}

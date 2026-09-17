import { z } from "zod";
import { claude, CLAUDE_PRO_MODEL, CLAUDE_SCALE_MODEL } from "../config/claude";
import { gemini, GEMINI_MODEL } from "../config/gemini";
import { ensureBillingAccount, type PlanTierId } from "./billing";

type ProviderName = "google" | "claude";

function isGoogleConfigured() {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

function isClaudeConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

function preferredProviderForTier(planId: PlanTierId): ProviderName {
  return planId === "free" ? "google" : "claude";
}

function claudeModelForTier(planId: PlanTierId) {
  return planId === "enterprise" ? CLAUDE_SCALE_MODEL : CLAUDE_PRO_MODEL;
}

async function resolveProvider(userId: string): Promise<{ provider: ProviderName; planId: PlanTierId }> {
  const account = await ensureBillingAccount(userId);
  const preferred = preferredProviderForTier(account.plan_id);

  if (preferred === "claude" && isClaudeConfigured()) {
    return { provider: "claude", planId: account.plan_id };
  }
  if (preferred === "google" && isGoogleConfigured()) {
    return { provider: "google", planId: account.plan_id };
  }
  if (isClaudeConfigured()) {
    return { provider: "claude", planId: account.plan_id };
  }
  if (isGoogleConfigured()) {
    return { provider: "google", planId: account.plan_id };
  }

  throw new Error("No AI provider is configured. Add GEMINI_API_KEY and/or ANTHROPIC_API_KEY to the backend environment.");
}

function extractClaudeText(
  content: Array<{ type: string; text?: string }>,
): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text?.trim() || "")
    .join("\n")
    .trim();
}

export async function generateStructuredForUser<T>(
  userId: string,
  schema: z.ZodType<T>,
  prompt: string,
  system?: string,
): Promise<T> {
  const { provider, planId } = await resolveProvider(userId);

  if (provider === "google") {
    const response = await gemini.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(schema),
      },
    });

    const text = response.text;
    if (!text) throw new Error("Google returned an empty response");
    const parsed = JSON.parse(text);
    return schema.parse(parsed);
  }

  const response = await claude.messages.create({
    model: claudeModelForTier(planId),
    max_tokens: 4000,
    system: system
      ? `${system}\nReturn valid JSON only. Do not wrap it in markdown.`
      : "Return valid JSON only. Do not wrap it in markdown.",
    messages: [{ role: "user", content: prompt }],
  });

  const text = extractClaudeText(response.content as Array<{ type: string; text?: string }>);
  if (!text) throw new Error("Claude returned an empty response");
  const parsed = JSON.parse(text);
  return schema.parse(parsed);
}

export async function generateTextForUser(
  userId: string,
  prompt: string,
  system?: string,
): Promise<string> {
  const { provider, planId } = await resolveProvider(userId);

  if (provider === "google") {
    const response = await gemini.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
    });
    return response.text?.trim() || "";
  }

  const response = await claude.messages.create({
    model: claudeModelForTier(planId),
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content: prompt }],
  });

  return extractClaudeText(response.content as Array<{ type: string; text?: string }>);
}


import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.warn("[claude] ANTHROPIC_API_KEY is not set - paid-tier Claude generation will fall back or fail.");
}

export const claude = new Anthropic({ apiKey: apiKey || "missing-api-key" });

export const CLAUDE_PRO_MODEL = process.env.CLAUDE_PRO_MODEL || "claude-3-5-sonnet-latest";
export const CLAUDE_SCALE_MODEL = process.env.CLAUDE_SCALE_MODEL || CLAUDE_PRO_MODEL;


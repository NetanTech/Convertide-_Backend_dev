import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.warn("[gemini] GEMINI_API_KEY is not set - AI generation endpoints will fail.");
}

export const gemini = new GoogleGenAI({ apiKey: apiKey || "missing-api-key" });

export const GEMINI_MODEL = "gemini-3-flash-preview";

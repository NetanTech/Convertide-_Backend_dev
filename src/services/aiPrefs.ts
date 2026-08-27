import type { AiPrefs } from "./settings";

/** Prompt block injected into Gemini (and similar) generation calls. */
export function buildAiPreferenceInstructions(ai: AiPrefs): string {
  const lines: string[] = [];

  if (ai.contentTone.trim()) {
    lines.push(
      `Content tone: write in a ${ai.contentTone.trim()} voice. Keep wording, examples, and phrasing consistent with that tone.`
    );
  }

  if (ai.contentLength.trim()) {
    const length = ai.contentLength.trim().toLowerCase();
    if (length === "short") {
      lines.push(
        "Content length: prefer short, concise output — fewer bullets, tighter phrases, no filler."
      );
    } else if (length === "long") {
      lines.push(
        "Content length: prefer longer, more detailed output — richer bullets and fuller explanations where useful."
      );
    } else {
      lines.push(
        "Content length: prefer a balanced medium length — specific but not overly verbose."
      );
    }
  }

  if (ai.preferredLanguage.trim()) {
    lines.push(
      `Language: produce all user-facing text in ${ai.preferredLanguage.trim()} (names, labels, summaries, and list items).`
    );
  }

  if (lines.length === 0) return "";

  return `\n\nUser AI preferences (follow these):\n- ${lines.join("\n- ")}`;
}

/** How many list items to keep for template-based generators. */
export function itemCountForLength(contentLength: string, short: number, medium: number, long: number) {
  const length = contentLength.trim().toLowerCase();
  if (length === "short") return short;
  if (length === "long") return long;
  return medium;
}

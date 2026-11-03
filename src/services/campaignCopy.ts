import type { AiPrefs } from "./settings";

export type AdPlatform = "meta" | "google" | "linkedin" | "tiktok" | "email";

export type CopyAngle = "headline" | "cta" | "emotional" | "logical";

export type CopyFormat =
  | "short"
  | "long"
  | "headline"
  | "description"
  | "hook"
  | "cta";

export type CampaignCopyItem = {
  text: string;
  score: number;
  platform: AdPlatform;
  personaId: string;
  format: CopyFormat;
  angle: CopyAngle;
  charLimit: number;
  charCount: number;
  withinLimit: boolean;
  feedback: string;
};

export type CampaignCopyTab = {
  label: string;
  prefix: string;
  platform: AdPlatform;
  items: CampaignCopyItem[];
};

export type PersonaCopyContext = {
  id: string;
  name: string;
  demographics?: { label: string; value: string }[] | null;
  psychographics?: { label: string; value: string }[] | null;
  pain_points?: { title?: string; text?: string; label?: string; value?: string }[] | string[] | null;
  goals?: { title?: string; text?: string; label?: string; value?: string }[] | string[] | null;
  buying_triggers?: { title?: string; text?: string; label?: string; value?: string }[] | string[] | null;
};

/** Platform character limits used for validation feedback (AC-005). */
export const PLATFORM_LIMITS: Record<
  AdPlatform,
  Partial<Record<CopyFormat, number>>
> = {
  meta: { short: 125, long: 500, headline: 40, cta: 30 },
  google: { headline: 30, description: 90, cta: 20 },
  linkedin: { hook: 150, long: 600, cta: 30, headline: 70 },
  tiktok: { hook: 100, short: 150, cta: 30 },
  email: { headline: 60, short: 90, long: 500, cta: 40 },
};

const PLATFORM_LABELS: Record<AdPlatform, string> = {
  meta: "Meta",
  google: "Google",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  email: "Email",
};

const MIN_VARIATIONS_PER_PLATFORM = 15;

type ToneKey = "professional" | "friendly" | "bold" | "conversational" | "luxury" | "default";

function toneKey(contentTone: string): ToneKey {
  const t = contentTone.trim().toLowerCase();
  if (t === "professional") return "professional";
  if (t === "friendly") return "friendly";
  if (t === "bold") return "bold";
  if (t === "conversational") return "conversational";
  if (t === "luxury") return "luxury";
  return "default";
}

function listText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  for (const key of ["text", "value", "title", "label"]) {
    if (typeof row[key] === "string" && row[key].trim()) return String(row[key]).trim();
  }
  return "";
}

function firstTexts(list: unknown[] | null | undefined, fallbacks: string[]): string[] {
  const fromList = (list ?? []).map(listText).filter(Boolean);
  return fromList.length > 0 ? fromList : fallbacks;
}

function demoValue(persona: PersonaCopyContext, labelPart: string, fallback: string): string {
  const hit = (persona.demographics ?? []).find((d) =>
    d.label?.toLowerCase().includes(labelPart.toLowerCase())
  );
  return hit?.value?.trim() || fallback;
}

function endsWithEllipsis(text: string): boolean {
  return /(?:\.\.\.|…|\u2026)\s*$/u.test(text.trim());
}

/**
 * Fit copy to a platform limit without faking compliance.
 * Soft word-boundary trim is allowed (no ellipsis). If it still will not fit,
 * keep the full line and mark it over limit in validateItem.
 */
function fitCopyToLimit(text: string, limit: number): { text: string; overLimit: boolean } {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return { text: "", overLimit: false };
  if (trimmed.length <= limit) return { text: trimmed, overLimit: false };

  let candidate = trimmed.slice(0, limit).trimEnd();
  const lastSpace = candidate.lastIndexOf(" ");
  if (lastSpace >= Math.floor(limit * 0.55)) {
    candidate = candidate.slice(0, lastSpace).trimEnd();
  }
  candidate = candidate.replace(/[,:;.\-–—\s]+$/u, "");

  if (candidate.length > 0 && candidate.length <= limit && !endsWithEllipsis(candidate)) {
    return { text: candidate, overLimit: false };
  }

  return { text: trimmed, overLimit: true };
}

/** Stable, non-staircase score from copy quality signals (not index-1 countdown). */
function scoreVariation(input: {
  text: string;
  withinLimit: boolean;
  format: CopyFormat;
  angle: CopyAngle;
  charLimit: number;
  index: number;
}): number {
  let s = 76;
  const ratio = input.charLimit > 0 ? input.text.length / input.charLimit : 1;

  if (ratio >= 0.35 && ratio <= 0.88) s += 9;
  else if (ratio > 0.88 && ratio <= 1) s += 4;
  else if (ratio < 0.2) s -= 5;
  else if (ratio > 1) s -= 14;

  if (input.withinLimit) s += 7;
  else s -= 10;

  if (input.format === "cta") s += 2;
  else if (input.format === "headline" || input.format === "hook") s += 3;
  if (input.angle === "logical") s += 2;
  else if (input.angle === "emotional") s += 1;

  let hash = 2166136261;
  for (let i = 0; i < input.text.length; i += 1) {
    hash ^= input.text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Spread -4..+8 so neighboring rows are not exact 1-point steps.
  s += (hash % 13) - 4;
  s -= Math.floor(input.index / 8);

  return Math.max(64, Math.min(96, Math.round(s)));
}

/** Phrases used as internal tone guidance — never show these as ad copy. */
const TONE_CUE_PHRASES = [
  "clear and direct",
  "precise and credible",
  "warm and approachable",
  "confident and urgent",
  "natural and human",
  "refined and selective",
] as const;

const INSTRUCTION_LEAK_RE =
  /\b(content tone|write in a|user ai preferences|follow these|prompt|instruction text|return valid json|system:|assistant:)\b/i;

/**
 * True when copy looks like prompt/tone guidance rather than publishable ad text.
 * Used to drop leaked instruction lines before save.
 */
export function isInstructionLeak(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (INSTRUCTION_LEAK_RE.test(t)) return true;
  const lower = t.toLowerCase();
  for (const phrase of TONE_CUE_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  // Meta-instructions about writing style / platform copy, not ads.
  if (/\b(linkedin|meta|google|tiktok)\s+copy\b/i.test(t)) return true;
  if (/\b(creative|narratives?|angles?)\s+that\b/i.test(t) && /\b(speaks to|sounds|focus)/i.test(t)) {
    return true;
  }
  if (/^[A-Z]+\s+angle\s*:/i.test(t)) return true;
  if (/^(tone|style|voice)\s*:/i.test(t)) return true;
  return false;
}

/** Drop instruction leaks; empty string if nothing usable remains. */
export function sanitizeVariationText(text: string): string {
  let next = text.trim().replace(/\s+/g, " ");
  if (!next || isInstructionLeak(next)) return "";
  return next;
}

function validateItem(
  text: string,
  platform: AdPlatform,
  format: CopyFormat,
  personaId: string,
  angle: CopyAngle,
  index: number
): CampaignCopyItem | null {
  const cleaned = sanitizeVariationText(text);
  if (!cleaned) return null;

  const charLimit = PLATFORM_LIMITS[platform][format] ?? 125;
  const fitted = fitCopyToLimit(cleaned, charLimit);
  if (!fitted.text || isInstructionLeak(fitted.text)) return null;

  // Ellipsis-truncated lines are never "within limit" even if charCount == limit.
  const looksTruncated = endsWithEllipsis(fitted.text);
  const charCount = fitted.text.length;
  const withinLimit = !fitted.overLimit && !looksTruncated && charCount <= charLimit;
  const platformLabel = PLATFORM_LABELS[platform];
  let feedback: string;
  if (withinLimit) {
    feedback = `${charCount}/${charLimit} · within ${platformLabel} ${format} limit`;
  } else if (looksTruncated) {
    feedback = `${charCount}/${charLimit} · truncated for ${platformLabel} ${format}. Rewrite to fit ${charLimit} characters without cutting off.`;
  } else {
    feedback = `${charCount}/${charLimit} · over ${platformLabel} ${format} limit by ${Math.max(0, charCount - charLimit)}. Shorten to ${charLimit} characters.`;
  }

  return {
    text: fitted.text,
    score: scoreVariation({
      text: fitted.text,
      withinLimit,
      format,
      angle,
      charLimit,
      index,
    }),
    platform,
    personaId,
    format,
    angle,
    charLimit,
    charCount,
    withinLimit,
    feedback,
  };
}

/** Map wizard channel labels to canonical ad platforms. */
export function resolveAdPlatforms(channels?: string[] | null): AdPlatform[] {
  const map: Record<string, AdPlatform> = {
    facebook: "meta",
    instagram: "meta",
    meta: "meta",
    "google ads": "google",
    google: "google",
    linkedin: "linkedin",
    tiktok: "tiktok",
    "email marketing": "email",
    email: "email",
  };

  // No channel list → generate the full set (legacy / draft without selection).
  if (!channels || channels.length === 0) {
    return ["meta", "google", "linkedin", "tiktok", "email"];
  }

  const resolved = new Set<AdPlatform>();
  for (const raw of channels) {
    const key = raw.trim().toLowerCase();
    const platform = map[key];
    if (platform) resolved.add(platform);
  }

  // Respect the wizard selection. Never invent Meta/Google when they were not chosen.
  return Array.from(resolved);
}

function uniquePush(target: string[], value: string) {
  const v = value.trim();
  if (!v) return;
  if (!target.some((t) => t.toLowerCase() === v.toLowerCase())) target.push(v);
}

function buildPersonaSeeds(persona: PersonaCopyContext) {
  const brand = persona.name || "Brand";
  const audience = demoValue(persona, "age", "your buyers");
  const location = demoValue(persona, "location", "your market");
  const pains = firstTexts(persona.pain_points as unknown[], [
    "wasted ad spend",
    "unclear messaging",
    "slow campaign launch",
  ]);
  const goals = firstTexts(persona.goals as unknown[], [
    "more qualified leads",
    "higher conversion rates",
    "consistent brand voice",
  ]);
  const triggers = firstTexts(persona.buying_triggers as unknown[], [
    "social proof",
    "clear ROI",
    "fast setup",
  ]);

  return { brand, audience, location, pains, goals, triggers };
}

function padToMinimum(texts: string[], factories: Array<() => string>, minimum: number): string[] {
  const out = [...texts];
  let i = 0;
  while (out.length < minimum && factories.length > 0) {
    uniquePush(out, factories[i % factories.length]());
    i += 1;
    if (i > minimum * 4) break;
  }
  return out.slice(0, Math.max(minimum, out.length));
}

function metaVariations(seeds: ReturnType<typeof buildPersonaSeeds>, tone: ToneKey): Array<{
  text: string;
  format: CopyFormat;
  angle: CopyAngle;
}> {
  const { brand, audience, location, pains, goals, triggers } = seeds;
  const rows: Array<{ text: string; format: CopyFormat; angle: CopyAngle }> = [];

  const shorts = [
    `${brand} helps ${audience} in ${location} skip ${pains[0]} and hit ${goals[0]}.`,
    `Tired of ${pains[0]}? ${brand} turns persona insight into ads that convert.`,
    `Reach ${audience} with ${brand} — built around ${goals[0]}.`,
    `${brand} leans into ${triggers[0]} so ${audience} actually stop scrolling.`,
    `Stop guessing on Meta. ${brand} matches messaging to ${audience}.`,
  ];
  shorts.forEach((text, i) => rows.push({ text, format: "short", angle: i % 2 === 0 ? "emotional" : "logical" }));

  const longs = [
    `${brand} was shaped for ${audience} in ${location}. If ${pains[0]} is slowing growth, we focus on ${goals[0]} and lean into ${triggers[0]} — so every scroll feels relevant.`,
    `Meta rewards clarity. ${brand} pairs short hooks with longer proof for ${audience}, addressing ${pains[1] ?? pains[0]} while pointing to ${goals[1] ?? goals[0]}.`,
    `From awareness to click, ${brand} keeps ${audience} moving. We open with ${triggers[0]}, acknowledge ${pains[0]}, and close on ${goals[0]} without sounding generic.`,
  ];
  longs.forEach((text) => rows.push({ text, format: "long", angle: "emotional" }));

  const headlines = [
    `${brand} for ${audience}`,
    `Skip ${pains[0]}`,
    `Win ${goals[0]}`,
    `${triggers[0]} that converts`,
    `Ads ${audience} notice`,
    `${brand}: clearer Meta`,
    `Persona-fit creative`,
    `${location}-ready offers`,
  ];
  headlines.forEach((text) => rows.push({ text, format: "headline", angle: "headline" }));

  const ctas = [
    "Get started",
    "See the plan",
    "Try free",
    "Book a demo",
    "Shop now",
    tone === "bold" ? "Launch now" : "Learn more",
  ];
  ctas.forEach((text) => rows.push({ text, format: "cta", angle: "cta" }));

  return rows;
}

function googleVariations(seeds: ReturnType<typeof buildPersonaSeeds>): Array<{
  text: string;
  format: CopyFormat;
  angle: CopyAngle;
}> {
  const { brand, audience, pains, goals, triggers } = seeds;
  const rows: Array<{ text: string; format: CopyFormat; angle: CopyAngle }> = [];

  const headlines = [
    `${brand} Ads That Convert`,
    `End ${pains[0]}`,
    `${goals[0]} Faster`,
    `Built for ${audience}`,
    `${triggers[0]} Proof`,
    `Smarter Search Copy`,
    `${brand} For SMEs`,
    `High-Intent Messaging`,
    `Persona-Based Ads`,
    `Cut Wasted Clicks`,
  ];
  headlines.forEach((text) => rows.push({ text, format: "headline", angle: "headline" }));

  const descriptions = [
    `${brand} helps ${audience} fix ${pains[0]} and hit ${goals[0]} with search-ready copy.`,
    `Generate Google headlines & descriptions aligned to ${triggers[0]} for ${audience}.`,
    `Clear RSA messaging from ${brand} — less waste, more intent match.`,
    `Search ads that mirror how ${audience} actually decides.`,
    `From keyword to click: ${brand} keeps benefits tight and relevant.`,
  ];
  descriptions.forEach((text) => rows.push({ text, format: "description", angle: "logical" }));

  const ctas = ["Get quote", "Learn more", "Try today", "Contact us"];
  ctas.forEach((text) => rows.push({ text, format: "cta", angle: "cta" }));

  return rows;
}

function linkedinVariations(seeds: ReturnType<typeof buildPersonaSeeds>, tone: ToneKey): Array<{
  text: string;
  format: CopyFormat;
  angle: CopyAngle;
}> {
  const { brand, audience, location, pains, goals, triggers } = seeds;
  const rows: Array<{ text: string; format: CopyFormat; angle: CopyAngle }> = [];

  const hooks = [
    `${brand} for leaders who refuse ${pains[0]}.`,
    `If ${audience} in ${location} need ${goals[0]}, start here.`,
    `Professional buyers respond to ${triggers[0]} — ${brand} leads with it.`,
    `${brand} keeps the message human while staying specific to ${audience}.`,
    `Stop broadcasting. Start conversations with ${brand}.`,
    `A practical path from ${pains[0]} to ${goals[0]}.`,
    `${brand}: persona-backed messaging for B2B feeds.`,
    `What ${audience} actually click — tested angles inside.`,
  ];
  hooks.forEach((text, i) =>
    rows.push({ text, format: "hook", angle: i % 2 === 0 ? "emotional" : "logical" })
  );

  const longs = [
    `${brand} helps teams serving ${audience} replace generic LinkedIn posts with specific narratives. We open on ${triggers[0]}, name ${pains[0]}, and show a credible path to ${goals[0]}.`,
    `In ${location}, attention is scarce. ${brand} keeps LinkedIn creative specific: who it's for, why now, and what happens next — without the buzzword fog.`,
  ];
  longs.forEach((text) => rows.push({ text, format: "long", angle: "logical" }));

  const headlines = [
    `${brand} for ${audience}`,
    `Fix ${pains[0]}`,
    `Toward ${goals[0]}`,
    `${triggers[0]} first`,
  ];
  headlines.forEach((text) => rows.push({ text, format: "headline", angle: "headline" }));

  const ctas = [
    tone === "professional" ? "Request a demo" : "See how it works",
    "Download the brief",
    "Start free",
    "Talk to sales",
  ];
  ctas.forEach((text) => rows.push({ text, format: "cta", angle: "cta" }));

  return rows;
}

function tiktokVariations(seeds: ReturnType<typeof buildPersonaSeeds>, tone: ToneKey): Array<{
  text: string;
  format: CopyFormat;
  angle: CopyAngle;
}> {
  const { brand, audience, pains, goals, triggers } = seeds;
  const rows: Array<{ text: string; format: CopyFormat; angle: CopyAngle }> = [];

  const hooks = [
    `POV: ${audience} finally ditch ${pains[0]} with ${brand}.`,
    `Wait for it — ${brand} just made ${goals[0]} feel easy.`,
    `If ${triggers[0]} gets you, watch this.`,
    `Stop scrolling if ${pains[0]} is your daily vibe.`,
    `${brand} said what ${audience} were thinking.`,
    `Hook → proof → ${goals[0]}. That's the ${brand} move.`,
    `Nobody told me ${brand} could fix ${pains[0]} this fast.`,
    `The ${audience} starter pack: ${brand}.`,
    tone === "bold" ? `${brand}. Louder results. Less fluff.` : `Soft launch energy, hard results — ${brand}.`,
    `3 seconds to care. ${brand} earns the rest.`,
  ];
  hooks.forEach((text) => rows.push({ text, format: "hook", angle: "emotional" }));

  const shorts = [
    `${brand} helps ${audience} turn ${triggers[0]} into action without ${pains[0]}.`,
    `Quick tip: lead with the pain, land on ${goals[0]} — ${brand} style.`,
    `Caption-ready lines for ${audience} who want ${goals[0]} now.`,
  ];
  shorts.forEach((text) => rows.push({ text, format: "short", angle: "logical" }));

  const ctas = ["Try it", "Link in bio", "Shop now", "Learn more", "Start free"];
  ctas.forEach((text) => rows.push({ text, format: "cta", angle: "cta" }));

  return rows;
}

function emailVariations(seeds: ReturnType<typeof buildPersonaSeeds>, tone: ToneKey): Array<{
  text: string;
  format: CopyFormat;
  angle: CopyAngle;
}> {
  const { brand, audience, location, pains, goals, triggers } = seeds;
  const rows: Array<{ text: string; format: CopyFormat; angle: CopyAngle }> = [];

  const subjects = [
    `${brand}: a clearer path to ${goals[0]}`,
    `Still dealing with ${pains[0]}?`,
    `${audience} in ${location} are switching to ${brand}`,
    `Quick win: ${triggers[0]} → ${goals[0]}`,
    `${brand} for ${audience} who want results`,
    `Don't let ${pains[0]} stall this week`,
    tone === "bold" ? `${brand}. Built for ${goals[0]}.` : `Something useful for ${audience}`,
    `Your ${goals[0]} plan starts here`,
  ];
  subjects.forEach((text) => rows.push({ text, format: "headline", angle: "headline" }));

  const previews = [
    `See how ${brand} helps ${audience} move past ${pains[0]}.`,
    `Open for a short take on ${goals[0]} and ${triggers[0]}.`,
    `Practical next steps for ${audience} in ${location}.`,
    `${brand} keeps the message specific, not generic.`,
  ];
  previews.forEach((text) => rows.push({ text, format: "short", angle: "logical" }));

  const bodies = [
    `Hi there — if ${pains[0]} is slowing ${audience} down, ${brand} focuses on ${goals[0]} with messaging built around ${triggers[0]}. Here's a simple next step you can try this week.`,
    `${brand} was shaped for ${audience} in ${location}. We open with ${triggers[0]}, acknowledge ${pains[0]}, and point clearly to ${goals[0]} without the fluff.`,
    `Most teams guess at email copy. ${brand} starts from persona insight so ${audience} hear something that matches how they decide.`,
  ];
  bodies.forEach((text) => rows.push({ text, format: "long", angle: "emotional" }));

  const ctas = [
    tone === "professional" ? "Read the brief" : "See how it works",
    "Get the plan",
    "Try it free",
    "Reply to this email",
  ];
  ctas.forEach((text) => rows.push({ text, format: "cta", angle: "cta" }));

  return rows;
}

function factoriesForPlatform(
  _platform: AdPlatform,
  seeds: ReturnType<typeof buildPersonaSeeds>
): Array<() => string> {
  const { brand, audience, pains, goals, triggers, location } = seeds;
  return [
    () => `${brand} × ${audience}: ${goals[0]}`,
    () => `Beat ${pains[0]} with ${brand}`,
    () => `${triggers[0]} → ${goals[0]}`,
    () => `${brand} in ${location}`,
    () => `Made for ${audience}`,
    () => `${brand} helps ${audience} reach ${goals[1] ?? goals[0]}`,
    () => `Why ${audience} pick ${brand}`,
    () => `From ${pains[1] ?? pains[0]} to clarity`,
  ];
}

/**
 * Builds ≥15 validated variations per selected platform, linked to the persona.
 * Template-based so generation stays well under the 30s SLA.
 */
export function buildPlatformCopyTabs(input: {
  persona: PersonaCopyContext;
  channels?: string[] | null;
  aiPrefs?: AiPrefs | null;
}): CampaignCopyTab[] {
  const tone = toneKey(input.aiPrefs?.contentTone ?? "");
  const seeds = buildPersonaSeeds(input.persona);
  const platforms = resolveAdPlatforms(input.channels);
  const personaId = input.persona.id;

  const builders: Record<
    AdPlatform,
    () => Array<{ text: string; format: CopyFormat; angle: CopyAngle }>
  > = {
    meta: () => metaVariations(seeds, tone),
    google: () => googleVariations(seeds),
    linkedin: () => linkedinVariations(seeds, tone),
    tiktok: () => tiktokVariations(seeds, tone),
    email: () => emailVariations(seeds, tone),
  };

  return platforms.map((platform) => {
    const raw = builders[platform]().filter((row) => !isInstructionLeak(row.text));
    const texts = padToMinimum(
      raw.map((r) => r.text).filter((t) => Boolean(sanitizeVariationText(t))),
      factoriesForPlatform(platform, seeds),
      MIN_VARIATIONS_PER_PLATFORM
    ).filter((t) => Boolean(sanitizeVariationText(t)));

    const items: CampaignCopyItem[] = [];
    for (let i = 0; i < texts.length; i += 1) {
      const template = raw[i % Math.max(raw.length, 1)];
      const format = template?.format ?? (platform === "google" ? "headline" : "short");
      const angle = template?.angle ?? "logical";
      const item = validateItem(texts[i], platform, format, personaId, angle, i);
      if (item) items.push(item);
    }

    // Guarantee minimum after stripping instruction leaks / limit fitting
    let guard = 0;
    while (items.length < MIN_VARIATIONS_PER_PLATFORM && guard < MIN_VARIATIONS_PER_PLATFORM * 4) {
      const i = items.length;
      const fillerSource =
        factoriesForPlatform(platform, seeds)[guard % 8]?.() ??
        `${seeds.brand} · ${seeds.goals[i % seeds.goals.length]} for ${seeds.audience}`;
      const item = validateItem(
        fillerSource,
        platform,
        platform === "tiktok" ? "hook" : "headline",
        personaId,
        "headline",
        i
      );
      if (item && !items.some((existing) => existing.text.toLowerCase() === item.text.toLowerCase())) {
        items.push(item);
      }
      guard += 1;
    }

    return {
      label: PLATFORM_LABELS[platform],
      prefix: PLATFORM_LABELS[platform],
      platform,
      items: items.slice(0, Math.max(MIN_VARIATIONS_PER_PLATFORM, items.length)),
    };
  });
}

export function summarizeCopyStats(tabs: CampaignCopyTab[]) {
  let headlines = 0;
  let ctaVariations = 0;
  let emotionalAngles = 0;
  let logicalAngles = 0;
  let invalidCount = 0;

  for (const tab of tabs) {
    for (const item of tab.items) {
      if (item.angle === "headline" || item.format === "headline") headlines += 1;
      if (item.angle === "cta" || item.format === "cta") ctaVariations += 1;
      if (item.angle === "emotional") emotionalAngles += 1;
      if (item.angle === "logical") logicalAngles += 1;
      if (!item.withinLimit) invalidCount += 1;
    }
  }

  const totalVariations = tabs.reduce((sum, tab) => sum + tab.items.length, 0);

  return {
    totalVariations,
    headlines,
    ctaVariations,
    emotionalAngles,
    logicalAngles,
    invalidCount,
    platforms: tabs.map((t) => t.platform),
    readingScore: invalidCount === 0 ? 92 : Math.max(70, 92 - invalidCount * 2),
    readingScoreLabel: invalidCount === 0 ? "Excellent" : "Needs edits",
  };
}

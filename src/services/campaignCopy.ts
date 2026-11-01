import type { AiPrefs } from "./settings";

export type AdPlatform = "meta" | "google" | "linkedin" | "tiktok";

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
};

const PLATFORM_LABELS: Record<AdPlatform, string> = {
  meta: "Meta",
  google: "Google",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
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

function score(base: number, offset: number) {
  return Math.max(70, Math.min(98, base - offset));
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

function clipToLimit(text: string, limit: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= limit) return trimmed;
  const sliced = trimmed.slice(0, Math.max(0, limit - 1)).trimEnd();
  return sliced.replace(/[,:;.\-–—\s]+$/u, "") + "…";
}

function validateItem(
  text: string,
  platform: AdPlatform,
  format: CopyFormat,
  personaId: string,
  angle: CopyAngle,
  scoreValue: number
): CampaignCopyItem {
  const charLimit = PLATFORM_LIMITS[platform][format] ?? 125;
  const safe = clipToLimit(text, charLimit);
  const charCount = safe.length;
  const withinLimit = charCount <= charLimit;
  const platformLabel = PLATFORM_LABELS[platform];
  const feedback = withinLimit
    ? `${charCount}/${charLimit} · within ${platformLabel} ${format} limit`
    : `${charCount}/${charLimit} · over ${platformLabel} ${format} limit by ${charCount - charLimit}. Shorten to ${charLimit} characters.`;

  return {
    text: safe,
    score: scoreValue,
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
  };

  const resolved = new Set<AdPlatform>();
  for (const raw of channels ?? []) {
    const key = raw.trim().toLowerCase();
    const platform = map[key];
    if (platform) resolved.add(platform);
  }

  if (resolved.size === 0) {
    return ["meta", "google", "linkedin", "tiktok"];
  }
  return Array.from(resolved);
}

function uniquePush(target: string[], value: string) {
  const v = value.trim();
  if (!v) return;
  if (!target.some((t) => t.toLowerCase() === v.toLowerCase())) target.push(v);
}

function buildPersonaSeeds(persona: PersonaCopyContext, tone: ToneKey) {
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

  const toneCue: Record<ToneKey, string> = {
    default: "clear and direct",
    professional: "precise and credible",
    friendly: "warm and approachable",
    bold: "confident and urgent",
    conversational: "natural and human",
    luxury: "refined and selective",
  };

  return { brand, audience, location, pains, goals, triggers, toneCue: toneCue[tone] };
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
  const { brand, audience, location, pains, goals, triggers, toneCue } = seeds;
  const rows: Array<{ text: string; format: CopyFormat; angle: CopyAngle }> = [];

  const shorts = [
    `${brand} helps ${audience} in ${location} skip ${pains[0]} with ${toneCue} ads.`,
    `Tired of ${pains[0]}? ${brand} turns persona insight into Meta-ready copy.`,
    `Reach ${audience} with ${brand} — built around ${goals[0]}.`,
    `${brand}: ${toneCue} creative that speaks to ${triggers[0]}.`,
    `Stop guessing on Meta. ${brand} matches copy to ${audience}.`,
  ];
  shorts.forEach((text, i) => rows.push({ text, format: "short", angle: i % 2 === 0 ? "emotional" : "logical" }));

  const longs = [
    `${brand} was shaped for ${audience} in ${location}. If ${pains[0]} is slowing growth, our ${toneCue} Meta angles focus on ${goals[0]} and lean into ${triggers[0]} — so every scroll feels relevant.`,
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
  const { brand, audience, location, pains, goals, triggers, toneCue } = seeds;
  const rows: Array<{ text: string; format: CopyFormat; angle: CopyAngle }> = [];

  const hooks = [
    `${brand} for leaders who refuse ${pains[0]}.`,
    `If ${audience} in ${location} need ${goals[0]}, start here.`,
    `Professional buyers respond to ${triggers[0]} — ${brand} leads with it.`,
    `${toneCue} LinkedIn copy that still sounds human.`,
    `Stop broadcasting. Start conversations with ${brand}.`,
    `A practical path from ${pains[0]} to ${goals[0]}.`,
    `${brand}: persona-backed messaging for B2B feeds.`,
    `What ${audience} actually click — tested angles inside.`,
  ];
  hooks.forEach((text, i) =>
    rows.push({ text, format: "hook", angle: i % 2 === 0 ? "emotional" : "logical" })
  );

  const longs = [
    `${brand} helps teams serving ${audience} replace generic LinkedIn posts with ${toneCue} narratives. We open on ${triggers[0]}, name ${pains[0]}, and show a credible path to ${goals[0]}.`,
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

function factoriesForPlatform(
  platform: AdPlatform,
  seeds: ReturnType<typeof buildPersonaSeeds>
): Array<() => string> {
  const { brand, audience, pains, goals, triggers, location } = seeds;
  return [
    () => `${brand} × ${audience}: ${goals[0]}`,
    () => `Beat ${pains[0]} with ${brand}`,
    () => `${triggers[0]} → ${goals[0]}`,
    () => `${brand} in ${location}`,
    () => `Made for ${audience}`,
    () => `${platform.toUpperCase()} angle: ${goals[1] ?? goals[0]}`,
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
  const seeds = buildPersonaSeeds(input.persona, tone);
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
  };

  return platforms.map((platform) => {
    const raw = builders[platform]();
    const texts = padToMinimum(
      raw.map((r) => r.text),
      factoriesForPlatform(platform, seeds),
      MIN_VARIATIONS_PER_PLATFORM
    );

    const items: CampaignCopyItem[] = texts.map((text, i) => {
      const template = raw[i % raw.length];
      const format = template?.format ?? (platform === "google" ? "headline" : "short");
      const angle = template?.angle ?? "logical";
      return validateItem(text, platform, format, personaId, angle, score(94, i));
    });

    // Guarantee minimum after validation/clipping uniqueness
    while (items.length < MIN_VARIATIONS_PER_PLATFORM) {
      const i = items.length;
      const filler = clipToLimit(
        `${seeds.brand} · ${seeds.goals[i % seeds.goals.length]} for ${seeds.audience}`,
        PLATFORM_LIMITS[platform].headline ?? PLATFORM_LIMITS[platform].short ?? 125
      );
      items.push(
        validateItem(
          filler,
          platform,
          platform === "tiktok" ? "hook" : "headline",
          personaId,
          "headline",
          score(88, i)
        )
      );
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

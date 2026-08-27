import type { AiPrefs } from "./settings";
import { itemCountForLength } from "./aiPrefs";
import { gemini, GEMINI_MODEL } from "../config/gemini";

type PersonaLite = {
  id: string;
  name: string;
  demographics?: { label: string; value: string }[];
};

function score(base: number, offset: number) {
  return Math.max(70, Math.min(98, base - offset));
}

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

function headlineBank(brand: string, tone: ToneKey): string[] {
  const banks: Record<ToneKey, string[]> = {
    default: [
      `Transform results with ${brand} — built for your ideal buyer.`,
      `Stop guessing. Start converting with ${brand}.`,
      `Your audience, decoded. Messaging that actually lands.`,
      `Launch smarter with AI-matched ${brand} campaigns.`,
      `Clear offers. Stronger pulls. Better ${brand} results.`,
      `Meet buyers where they are — with ${brand}.`,
    ],
    professional: [
      `Drive measurable growth with ${brand} for your priority segment.`,
      `Evidence-based messaging that positions ${brand} with clarity.`,
      `Precision targeting and conversion-ready ${brand} creative.`,
      `Structured campaigns built around ${brand}'s ideal customer.`,
      `Reduce acquisition waste with persona-aligned ${brand} ads.`,
      `Operational excellence meets customer insight — ${brand}.`,
    ],
    friendly: [
      `Hey — ${brand} was made with people like you in mind.`,
      `Feel seen. Feel ready. Start with ${brand}.`,
      `Good vibes, clearer choices — that's ${brand}.`,
      `Let's make marketing feel human again with ${brand}.`,
      `Your next win with ${brand} starts with a friendly hello.`,
      `Warm words. Real results. ${brand} has your back.`,
    ],
    bold: [
      `Own the feed. Dominate the funnel. ${brand}.`,
      `No soft launches. Go loud with ${brand}.`,
      `Cut the noise. Convert harder with ${brand}.`,
      `Big claims. Backed by buyers who want ${brand}.`,
      `Stop blending in — ${brand} was built to stand out.`,
      `Hit harder. Scale faster. ${brand}.`,
    ],
    conversational: [
      `So… ready to see what ${brand} can do for your buyers?`,
      `Here's the thing: ${brand} talks the way your audience thinks.`,
      `Let's skip the jargon and just get ${brand} working.`,
      `If your customers could write the ad, it'd sound like ${brand}.`,
      `Quick question — what if ${brand} already knew them?`,
      `Talk with your market, not at them — ${brand}.`,
    ],
    luxury: [
      `Refined. Considered. Distinctly ${brand}.`,
      `For audiences who expect more — ${brand} delivers.`,
      `Quiet confidence. Elevated craft. ${brand}.`,
      `Exquisite positioning for the ${brand} connoisseur.`,
      `Where taste meets intention — ${brand}.`,
      `An exclusive standard of care, by ${brand}.`,
    ],
  };
  return banks[tone];
}

function ctaBank(tone: ToneKey): string[] {
  const banks: Record<ToneKey, string[]> = {
    default: ["Get Started Free", "See How It Works", "Build My Campaign", "Claim Your Plan", "Try It Now", "Explore Options"],
    professional: ["Request a Demo", "Review the Plan", "Start Your Trial", "Schedule a Walkthrough", "Get the Brief", "Continue"],
    friendly: ["Let's Go", "Show Me Around", "I'm In", "Start Together", "Take a Peek", "Join In"],
    bold: ["Launch Now", "Take the Lead", "Go Full Send", "Claim It", "Scale Up", "Make the Move"],
    conversational: ["Show me", "Okay, let's try", "Walk me through it", "I'm curious", "Next step", "Tell me more"],
    luxury: ["Begin the Experience", "Reserve Access", "Discover More", "Enter Privately", "Request Admission", "Explore the Collection"],
  };
  return banks[tone];
}

function emotionalBank(tone: ToneKey): string[] {
  const banks: Record<ToneKey, string[]> = {
    default: [
      "Because your customers deserve messaging that feels personal.",
      "Less noise. More clarity. Real connection.",
      "Confidence starts with knowing who you're talking to.",
      "Meet emotion with intent — then convert.",
      "Make every touchpoint feel like it was written for them.",
    ],
    professional: [
      "Trust grows when messaging respects the buyer's time and goals.",
      "Clarity builds confidence across every stakeholder.",
      "Aligned narratives reduce friction in complex decisions.",
      "Professional tone, personal relevance — both matter.",
      "Credibility compounds when proof and empathy travel together.",
    ],
    friendly: [
      "A little warmth goes a long way in a crowded inbox.",
      "People buy from brands that feel like a good friend.",
      "Smile-worthy copy still converts — when it's honest.",
      "Be approachable without being forgettable.",
      "Connection first. Conversion follows.",
    ],
    bold: [
      "Make them feel the stakes — then offer the way out.",
      "Urgency with integrity hits harder than hype alone.",
      "Spark ambition. Channel it into action.",
      "Big feelings drive big clicks when the offer is clear.",
      "Don't whisper the benefit. Own it.",
    ],
    conversational: [
      "Talk like a person. Sell like a partner.",
      "If it sounds like a brochure, rewrite it.",
      "Ask the question your customer is already thinking.",
      "Keep it human — that's the advantage.",
      "A natural line beats a clever line they don't trust.",
    ],
    luxury: [
      "Desire deepens when the story feels exclusive.",
      "Restraint can be the most persuasive emotion.",
      "Invite them into a world — don't shout them in.",
      "Elegance signals value before the price appears.",
      "Aspiration, handled with care, converts quietly.",
    ],
  };
  return banks[tone];
}

function logicalBank(tone: ToneKey): string[] {
  const banks: Record<ToneKey, string[]> = {
    default: [
      "Persona-backed copy tested across high-intent channels.",
      "Clear CTAs designed to lift conversion without guesswork.",
      "Ready-to-ship variants for ads, email, and organic posts.",
      "Structured messaging mapped to buyer stage and intent.",
      "Measurable angles you can A/B without starting from scratch.",
    ],
    professional: [
      "Hypothesis-driven variants ready for controlled testing.",
      "Channel-specific messaging with clear success metrics.",
      "Decision-ready copy aligned to funnel stage economics.",
      "Reduce cycle time from brief to live creative.",
      "Documented angles your team can brief against immediately.",
    ],
    friendly: [
      "Simple lines that still respect how people actually decide.",
      "Helpful prompts that make the next step obvious.",
      "Practical copy your team can post today.",
      "Easy swaps for stories, ads, and emails.",
      "Clear benefits without the corporate fog.",
    ],
    bold: [
      "Higher contrast offers for faster decision velocity.",
      "Sharper claims matched to high-intent moments.",
      "Variants built to win the scroll and the click.",
      "Aggressive testing roadmap baked into the pack.",
      "No soft metrics — copy aimed at conversion.",
    ],
    conversational: [
      "Plain-language proof points that still sound natural.",
      "Questions and answers that mirror real buyer chats.",
      "Copy that fits comments, DMs, and landing pages alike.",
      "Less pitch deck. More useful talk.",
      "Reasoning your audience would actually say out loud.",
    ],
    luxury: [
      "Benefits framed as craft, rarity, and lasting value.",
      "Proof points that elevate without overselling.",
      "Selective messaging for high-consideration journeys.",
      "Refined CTAs for audiences who dislike pressure.",
      "Quality signals woven into every line.",
    ],
  };
  return banks[tone];
}

async function translateTexts(texts: string[], language: string): Promise<string[]> {
  const target = language.trim();
  if (!target || /^english$/i.test(target) || texts.length === 0) return texts;

  try {
    const response = await gemini.models.generateContent({
      model: GEMINI_MODEL,
      contents: `Translate each string into ${target}. Keep marketing punch and meaning. Return JSON: {"items":["..."]} with the same length and order.\n\n${JSON.stringify(texts)}`,
      config: { responseMimeType: "application/json" },
    });
    const raw = response.text;
    if (!raw) return texts;
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (!Array.isArray(parsed.items) || parsed.items.length !== texts.length) return texts;
    return parsed.items.map((item, i) => (typeof item === "string" && item.trim() ? item : texts[i]));
  } catch (err) {
    console.error("[generators] language localization failed", err);
    return texts;
  }
}

export async function buildCampaignPayload(
  persona: PersonaLite,
  name?: string,
  durationDays?: number,
  aiPrefs?: AiPrefs
) {
  const brand = persona.name || "Brand";
  const campaignName = name?.trim() || `${brand} – New Launch Campaign`;
  const tone = toneKey(aiPrefs?.contentTone ?? "");
  const length = aiPrefs?.contentLength ?? "";

  const headlineN = itemCountForLength(length, 2, 4, 6);
  const ctaN = itemCountForLength(length, 2, 4, 6);
  const emotionalN = itemCountForLength(length, 2, 3, 5);
  const logicalN = itemCountForLength(length, 2, 3, 5);

  let headlines = headlineBank(brand, tone).slice(0, headlineN);
  let ctas = ctaBank(tone).slice(0, ctaN);
  let emotional = emotionalBank(tone).slice(0, emotionalN);
  let logical = logicalBank(tone).slice(0, logicalN);

  const language = aiPrefs?.preferredLanguage ?? "";
  if (language.trim() && !/^english$/i.test(language.trim())) {
    const translated = await translateTexts([...headlines, ...ctas, ...emotional, ...logical], language);
    let cursor = 0;
    headlines = translated.slice(cursor, (cursor += headlines.length));
    ctas = translated.slice(cursor, (cursor += ctas.length));
    emotional = translated.slice(cursor, (cursor += emotional.length));
    logical = translated.slice(cursor, (cursor += logical.length));
  }

  const tabs = [
    {
      label: "Headlines",
      prefix: "Headline",
      items: headlines.map((text, i) => ({ text, score: score(94, i * 2) })),
    },
    {
      label: "CTA Variations",
      prefix: "CTA",
      items: ctas.map((text, i) => ({ text, score: score(92, i * 2) })),
    },
    {
      label: "Emotional Copy",
      prefix: "Emotional",
      items: emotional.map((text, i) => ({ text, score: score(90, i * 3) })),
    },
    {
      label: "Logical Copy",
      prefix: "Logical",
      items: logical.map((text, i) => ({ text, score: score(91, i * 3) })),
    },
  ];

  const headlineCount = tabs[0].items.length;
  const ctaVariations = tabs[1].items.length;
  const emotionalAngles = tabs[2].items.length;
  const totalVariations = tabs.reduce((sum, tab) => sum + tab.items.length, 0);

  return {
    name: campaignName,
    persona_id: persona.id,
    persona_name: persona.name,
    status: "active" as const,
    duration: durationDays ?? null,
    conversions: { total: 0, rate: 0 },
    stats: {
      totalVariations,
      headlines: headlineCount,
      ctaVariations,
      emotionalAngles,
      readingScore: 90,
      readingScoreLabel: "Excellent",
    },
    tabs,
  };
}

function weekTasks(tone: ToneKey, length: string): string[] {
  const base: Record<ToneKey, string[]> = {
    default: ["Market research", "Audience analysis", "Brand messaging", "Step up tracking", "Creative drafts", "Channel tests"],
    professional: [
      "Stakeholder brief",
      "Audience analysis",
      "Message architecture",
      "Measurement plan",
      "Creative review",
      "Performance readout",
    ],
    friendly: [
      "Listen to your audience",
      "Map their day-to-day",
      "Draft warm messaging",
      "Share early concepts",
      "Light channel tests",
      "Celebrate quick wins",
    ],
    bold: [
      "Competitive teardown",
      "Sharpen the offer",
      "High-impact creatives",
      "Aggressive test plan",
      "Push winning ads",
      "Double down on lifts",
    ],
    conversational: [
      "Collect real customer phrases",
      "Draft talk-like copy",
      "Social listening sweep",
      "Soft-launch conversations",
      "Iterate from replies",
      "Publish what resonates",
    ],
    luxury: [
      "Refine brand codes",
      "Curate audience signals",
      "Craft elevated narratives",
      "Selective channel mix",
      "Polish hero assets",
      "Measure brand lift",
    ],
  };
  const n = itemCountForLength(length, 3, 4, 6);
  return base[tone].slice(0, n);
}

export async function buildPlanPayload(input: {
  persona: PersonaLite;
  campaign?: { id: string; name: string } | null;
  name?: string;
  budget?: string;
  durationDays?: number;
  aiPrefs?: AiPrefs;
}) {
  const days = input.durationDays ?? 90;
  const weekCount = Math.max(6, Math.ceil(days / 7));
  const brand = input.persona.name || "Brand";
  const age = input.persona.demographics?.find((d) => /age/i.test(d.label))?.value ?? "18–45";
  const gender = input.persona.demographics?.find((d) => /gender/i.test(d.label))?.value ?? "Mixed";
  const tone = toneKey(input.aiPrefs?.contentTone ?? "");
  const length = input.aiPrefs?.contentLength ?? "";
  const tasks = weekTasks(tone, length);

  const start = new Date();
  const end = new Date(start);
  end.setDate(start.getDate() + days);

  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  let weekly = Array.from({ length: weekCount }, (_, i) => ({
    week: i + 1,
    days: "Days 1–7",
    tasks: [...tasks],
  }));

  const language = input.aiPrefs?.preferredLanguage ?? "";
  if (language.trim() && !/^english$/i.test(language.trim())) {
    const flat = weekly.flatMap((w) => w.tasks);
    const translated = await translateTexts(flat, language);
    let cursor = 0;
    weekly = weekly.map((w) => {
      const next = translated.slice(cursor, cursor + w.tasks.length);
      cursor += w.tasks.length;
      return { ...w, tasks: next };
    });
  }

  const campaignMeta =
    tone === "luxury"
      ? "Curated growth campaign"
      : tone === "bold"
        ? "High-impact growth campaign"
        : "AI-generated growth campaign";

  return {
    name: input.name?.trim() || `${brand} - ${days} Days Marketing Plan`,
    status: "Active" as const,
    persona_id: input.persona.id,
    campaign_id: input.campaign?.id ?? null,
    persona_snapshot: {
      name: brand,
      meta: `${age} • ${gender}`,
    },
    campaign_snapshot: {
      name: input.campaign?.name ?? `${brand} Campaign`,
      meta: campaignMeta,
    },
    budget: input.budget?.trim() || "$1,000",
    timeline: {
      duration: `${days} Days`,
      range: `${fmt(start)} – ${fmt(end)}`,
    },
    channel_mix: [
      { platform: "instagram", label: "Instagram", percent: 30 },
      { platform: "facebook", label: "Facebook", percent: 25 },
      { platform: "email", label: "Email marketing", percent: 20 },
      { platform: "tiktok", label: "Tiktok", percent: 15 },
      { platform: "other", label: "Others", percent: 10 },
    ],
    weekly_action_plan: weekly,
    content_calendar: [
      { platform: "instagram", label: "Instagram", format: "Reels" },
      { platform: "facebook", label: "Facebook", format: "Posts" },
      { platform: "email", label: "Email marketing", format: "Newsletter" },
      { platform: "tiktok", label: "Tiktok", format: "Videos" },
    ],
    kpis: [
      { label: "Website Traffic", value: "+30%", delta: "+14.2%", positive: true },
      { label: "Leads Generated", value: "500", delta: "+9.6%", positive: true },
      { label: "Email Signups", value: "200", delta: "+11.3%", positive: true },
      { label: "Engagement Rate", value: "4.7%", delta: "+2.1%", positive: true },
      { label: "Sales", value: "62.4%", delta: "+1.8%", positive: true },
    ],
    expected_outcome: [
      { label: "People Reach", value: "40k – 60k" },
      { label: "Qualified Leads", value: "1,200+" },
      { label: "Increase in Awareness", value: "25% – 35%" },
      { label: "Increase in Conversion", value: "8% – 12%" },
    ],
  };
}

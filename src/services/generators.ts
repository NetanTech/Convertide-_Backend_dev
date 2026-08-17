type PersonaLite = {
  id: string;
  name: string;
  demographics?: { label: string; value: string }[];
};

function score(base: number, offset: number) {
  return Math.max(70, Math.min(98, base - offset));
}

export function buildCampaignPayload(persona: PersonaLite, name?: string) {
  const brand = persona.name || "Brand";
  const campaignName = name?.trim() || `${brand} – New Launch Campaign`;

  const tabs = [
    {
      label: "Headlines",
      prefix: "Headline",
      items: [
        { text: `Transform results with ${brand} — built for your ideal buyer.`, score: score(94, 0) },
        { text: `Stop guessing. Start converting with ${brand}.`, score: score(94, 3) },
        { text: `Your audience, decoded. Messaging that actually lands.`, score: score(94, 6) },
        { text: `Launch smarter with AI-matched ${brand} campaigns.`, score: score(94, 8) },
      ],
    },
    {
      label: "CTA Variations",
      prefix: "CTA",
      items: [
        { text: "Get Started Free", score: score(92, 0) },
        { text: "See How It Works", score: score(92, 3) },
        { text: "Build My Campaign", score: score(92, 5) },
        { text: "Claim Your Plan", score: score(92, 8) },
      ],
    },
    {
      label: "Emotional Copy",
      prefix: "Emotional",
      items: [
        { text: "Because your customers deserve messaging that feels personal.", score: score(90, 0) },
        { text: "Less noise. More clarity. Real connection.", score: score(90, 4) },
        { text: "Confidence starts with knowing who you're talking to.", score: score(90, 7) },
      ],
    },
    {
      label: "Logical Copy",
      prefix: "Logical",
      items: [
        { text: "Persona-backed copy tested across high-intent channels.", score: score(91, 0) },
        { text: "Clear CTAs designed to lift conversion without guesswork.", score: score(91, 4) },
        { text: "Ready-to-ship variants for ads, email, and organic posts.", score: score(91, 7) },
      ],
    },
  ];

  const headlines = tabs[0].items.length;
  const ctaVariations = tabs[1].items.length;
  const emotionalAngles = tabs[2].items.length;
  const totalVariations = tabs.reduce((sum, tab) => sum + tab.items.length, 0);

  return {
    name: campaignName,
    persona_id: persona.id,
    stats: {
      totalVariations,
      headlines,
      ctaVariations,
      emotionalAngles,
      readingScore: 90,
      readingScoreLabel: "Excellent",
    },
    tabs,
  };
}

export function buildPlanPayload(input: {
  persona: PersonaLite;
  campaign?: { id: string; name: string } | null;
  name?: string;
  budget?: string;
  durationDays?: number;
}) {
  const days = input.durationDays ?? 90;
  const weekCount = Math.max(4, Math.ceil(days / 7));
  const brand = input.persona.name || "Brand";
  const age = input.persona.demographics?.find((d) => /age/i.test(d.label))?.value ?? "18–45";
  const gender = input.persona.demographics?.find((d) => /gender/i.test(d.label))?.value ?? "Mixed";

  const start = new Date();
  const end = new Date(start);
  end.setDate(start.getDate() + days);

  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

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
      meta: "AI-generated growth campaign",
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
    weekly_action_plan: Array.from({ length: weekCount }, (_, i) => ({
      week: i + 1,
      days: "Days 1–7",
      tasks: ["Market research", "Audience analysis", "Brand messaging", "Step up tracking"],
    })),
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

import { buildPlatformCopyTabs, summarizeCopyStats } from "../src/services/campaignCopy";

const tabs = buildPlatformCopyTabs({
  persona: {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Urban Glow",
    demographics: [{ label: "Age", value: "25-34" }],
    pain_points: ["dry skin"],
    goals: ["glow"],
    buying_triggers: ["reviews"],
  },
  channels: ["facebook", "Google ads", "LinkedIN", "TikTok"],
  aiPrefs: {
    contentTone: "friendly",
    contentLength: "",
    preferredLanguage: "",
    autoSaveAiResults: true,
  },
});

for (const tab of tabs) {
  const invalid = tab.items.filter((i) => !i.withinLimit).length;
  console.log(`${tab.platform}: ${tab.items.length} variations (${invalid} over limit)`);
  if (tab.items.length < 15) {
    process.exitCode = 1;
  }
}

console.log("total", summarizeCopyStats(tabs).totalVariations);

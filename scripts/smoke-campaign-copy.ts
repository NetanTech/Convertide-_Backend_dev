import {
  buildPlatformCopyTabs,
  isInstructionLeak,
  summarizeCopyStats,
} from "../src/services/campaignCopy";

const tabs = buildPlatformCopyTabs({
  persona: {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Urban Glow",
    demographics: [{ label: "Age", value: "25-34" }],
    pain_points: ["dry skin"],
    goals: ["glow"],
    buying_triggers: ["reviews"],
  },
  channels: ["facebook", "Google ads", "LinkedIN", "TikTok", "Email marketing"],
  aiPrefs: {
    contentTone: "friendly",
    contentLength: "",
    preferredLanguage: "",
    autoSaveAiResults: true,
  },
});

const scoped = buildPlatformCopyTabs({
  persona: {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Urban Glow",
    demographics: [{ label: "Age", value: "25-34" }],
    pain_points: ["dry skin"],
    goals: ["glow"],
    buying_triggers: ["reviews"],
  },
  channels: ["LinkedIN", "Email marketing"],
  aiPrefs: {
    contentTone: "friendly",
    contentLength: "",
    preferredLanguage: "",
    autoSaveAiResults: true,
  },
});

const scopedPlatforms = scoped.map((t) => t.platform).sort().join(",");
if (scopedPlatforms !== "email,linkedin") {
  console.error("channel filter failed:", scopedPlatforms);
  process.exitCode = 1;
} else {
  console.log("scoped LinkedIn+Email ->", scopedPlatforms);
}

function endsWithEllipsis(text: string) {
  return /(?:\.\.\.|…|\u2026)\s*$/u.test(text.trim());
}

for (const tab of tabs) {
  const invalid = tab.items.filter((i) => !i.withinLimit).length;
  const leaks = tab.items.filter((i) => isInstructionLeak(i.text));
  const fakeWithin = tab.items.filter((i) => i.withinLimit && endsWithEllipsis(i.text));
  const scores = tab.items.map((i) => i.score);
  let staircase = 0;
  for (let i = 1; i < scores.length; i += 1) {
    if (scores[i - 1] - scores[i] === 1) staircase += 1;
  }

  console.log(
    `${tab.platform}: ${tab.items.length} variations (${invalid} over limit, ${leaks.length} leaks, ${fakeWithin.length} ellipsis-within, staircaseSteps=${staircase})`,
  );
  console.log(`  scores: ${scores.slice(0, 8).join(", ")}${scores.length > 8 ? ", ..." : ""}`);

  if (tab.items.length < 15 || leaks.length > 0 || fakeWithin.length > 0) {
    process.exitCode = 1;
  }
  // More than half the adjacent pairs dropping by exactly 1 looks synthetic.
  if (scores.length > 4 && staircase >= Math.floor(scores.length * 0.6)) {
    console.error(`${tab.platform}: scores look like a 1-point staircase`);
    process.exitCode = 1;
  }
  if (tab.platform === "meta" && tab.items[3] && isInstructionLeak(tab.items[3].text)) {
    console.error("meta variation #04 still looks like instruction text:", tab.items[3].text);
    process.exitCode = 1;
  }
}

console.log("total", summarizeCopyStats(tabs).totalVariations);

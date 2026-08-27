export type HelpArticle = {
  slug: string;
  title: string;
  body: string;
};

export type HelpFaq = {
  question: string;
  answer: string;
};

export const HELP_ARTICLES: HelpArticle[] = [
  {
    slug: "first-persona",
    title: "Creating Your First Persona",
    body: "Go to Personas → New Persona, describe your audience or product, then generate. Review demographics, pain points, and messaging angles, edit anything that needs tweaking, and save. Use that persona when you create campaigns and plans so AI stays aimed at the right buyer.",
  },
  {
    slug: "first-campaign",
    title: "Building Your First Campaign",
    body: "Open Campaigns → New Campaign, pick a persona, set your goal and channels, then generate. Review the copy and creative suggestions, refine in the wizard steps, and export or save assets you want to keep.",
  },
  {
    slug: "first-plan",
    title: "Generating Your First Marketing Plan",
    body: "From Plans → Create Plan, choose a persona and timeframe, then generate. The plan outlines channels, cadence, and messaging. Edit sections as needed and export when you’re ready to share with your team.",
  },
  {
    slug: "ai-credits",
    title: "Understanding AI Credits",
    body: "Each AI generation (persona, campaign, or plan) uses credits from your monthly allowance. Check Billing for your balance and plan. You’ll get a heads-up when credits run low if that notification is enabled in Settings.",
  },
  {
    slug: "exporting-plans",
    title: "Exporting Your Marketing Plan",
    body: "Open a saved plan and use Export to download or share a copy with stakeholders. You can still edit the plan in Convert Tide after exporting.",
  },
];

export const HELP_FAQS: HelpFaq[] = [
  {
    question: "How can I benefit from the AI-generated personas?",
    answer:
      "AI personas give you a clear picture of who you're selling to — demographics, pain points, goals, and messaging angles — so campaigns and plans stay focused on the right audience.",
  },
  {
    question: "Can I edit the AI-generated results?",
    answer:
      "Yes. Every persona, campaign, and plan can be reviewed and edited before you export or share it.",
  },
  {
    question: "What can I export from ConvertTide?",
    answer:
      "You can export personas, campaign details, and marketing plans for sharing with your team or stakeholders.",
  },
  {
    question: "Is there a free trial?",
    answer:
      "Yes. You can try ConvertTide free before choosing a plan that fits your team.",
  },
  {
    question: "How do AI credits work?",
    answer:
      "Each generation — persona, campaign, or plan — uses a set number of AI credits from your monthly allowance.",
  },
];

import { SUPPORTED_INDUSTRIES, isSupportedIndustry } from "../lib/personaIndustries";
import { logAccountAudit } from "./accountAudit";

export type ImportSourceKind = "website" | "linkedin";

export type ImportedBusinessFields = {
  businessName?: string;
  industry?: string;
  offerings?: string;
  targetCustomers?: string[];
};

export type BusinessContextImportResult = {
  source: ImportSourceKind;
  sourceUrl: string;
  sourceLabel: string;
  fields: ImportedBusinessFields;
  partial: boolean;
  warnings: string[];
  fetchedAt: string;
};

export class BusinessContextImportError extends Error {
  code:
    | "consent_required"
    | "invalid_url"
    | "linkedin_unsupported"
    | "unreachable"
    | "empty_page"
    | "partial_only";

  constructor(
    code: BusinessContextImportError["code"],
    message: string,
  ) {
    super(message);
    this.name = "BusinessContextImportError";
    this.code = code;
  }
}

const INDUSTRY_KEYWORDS: Array<{ industry: (typeof SUPPORTED_INDUSTRIES)[number]; patterns: RegExp[] }> = [
  { industry: "Technology", patterns: [/saas/i, /\bsoftware\b/i, /\bapp\b/i, /\bapi\b/i, /devtools/i, /cloud/i] },
  {
    industry: "Beauty & Personal Care",
    patterns: [/skincare/i, /\bbeauty\b/i, /cosmetics/i, /haircare/i, /fragrance/i],
  },
  { industry: "Fashion & Apparel", patterns: [/fashion/i, /apparel/i, /clothing/i, /streetwear/i, /footwear/i] },
  { industry: "Food & Beverage", patterns: [/restaurant/i, /cafe/i, /coffee/i, /beverage/i, /\bfood\b/i, /bakery/i] },
  {
    industry: "Health & Wellness",
    patterns: [/wellness/i, /fitness/i, /clinic/i, /therapy/i, /healthcare/i, /nutrition/i],
  },
  { industry: "Home & Lifestyle", patterns: [/furniture/i, /home\s*decor/i, /lifestyle/i, /interior/i] },
  { industry: "E-commerce", patterns: [/shop\s*now/i, /add\s*to\s*cart/i, /online\s*store/i, /ecommerce/i, /e-commerce/i] },
  { industry: "Retail", patterns: [/\bretail\b/i, /boutique/i, /storefront/i] },
];

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function metaContent(html: string, key: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${key}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]).trim();
  }
  return null;
}

function titleText(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match?.[1] ? decodeHtmlEntities(match[1]).trim() : null;
}

function normalizeUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new BusinessContextImportError("invalid_url", "Enter a website URL to import from.");
  }

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new BusinessContextImportError(
      "invalid_url",
      "That doesn’t look like a valid URL. Check the address and try again."
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BusinessContextImportError("invalid_url", "Only http and https URLs are supported.");
  }

  if (!parsed.hostname.includes(".")) {
    throw new BusinessContextImportError("invalid_url", "Enter a full website address, e.g. https://example.com.");
  }

  return parsed;
}

function detectSource(url: URL): ImportSourceKind {
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
  return "website";
}

function guessIndustry(text: string): string | undefined {
  for (const row of INDUSTRY_KEYWORDS) {
    if (row.patterns.some((p) => p.test(text))) return row.industry;
  }
  return undefined;
}

function guessBusinessName(url: URL, ogSite: string | null, title: string | null): string | undefined {
  if (ogSite && ogSite.length <= 120) return ogSite;
  if (title) {
    const cleaned = title.split(/[|\-–—]/)[0]?.trim();
    if (cleaned && cleaned.length >= 2 && cleaned.length <= 120) return cleaned;
  }
  const host = url.hostname.replace(/^www\./i, "");
  const base = host.split(".")[0];
  if (!base || base.length < 2) return undefined;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function validateFields(fields: ImportedBusinessFields): {
  fields: ImportedBusinessFields;
  rejected: string[];
} {
  const next: ImportedBusinessFields = {};
  const rejected: string[] = [];

  if (fields.businessName) {
    const name = fields.businessName.trim().slice(0, 120);
    if (name.length >= 2) next.businessName = name;
    else rejected.push("businessName");
  }

  if (fields.industry) {
    if (isSupportedIndustry(fields.industry)) next.industry = fields.industry;
    else rejected.push("industry");
  }

  if (fields.offerings) {
    const offerings = fields.offerings.trim().slice(0, 2000);
    if (offerings.length >= 4) next.offerings = offerings;
    else rejected.push("offerings");
  }

  if (fields.targetCustomers?.length) {
    const cleaned = fields.targetCustomers.map((v) => v.trim()).filter(Boolean).slice(0, 8);
    if (cleaned.length) next.targetCustomers = cleaned;
    else rejected.push("targetCustomers");
  }

  return { fields: next, rejected };
}

async function fetchHtml(url: URL): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "ConvertideBot/1.0 (+https://converttide.com; business-context-import)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!res.ok) {
      throw new BusinessContextImportError(
        "unreachable",
        `We couldn’t open that page (${res.status}). Check the URL or try again later.`
      );
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
      throw new BusinessContextImportError(
        "empty_page",
        "That URL didn’t return a web page we can read. Try the homepage URL instead."
      );
    }

    const html = await res.text();
    if (!html || html.trim().length < 40) {
      throw new BusinessContextImportError(
        "empty_page",
        "The page had no readable content. Try a different public URL."
      );
    }
    return html.slice(0, 500_000);
  } catch (err) {
    if (err instanceof BusinessContextImportError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new BusinessContextImportError(
        "unreachable",
        "The page took too long to respond. Try again, or use a simpler public URL."
      );
    }
    throw new BusinessContextImportError(
      "unreachable",
      "We couldn’t reach that website. Check your connection and the URL, then retry."
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseWebsiteHtml(url: URL, html: string): {
  fields: ImportedBusinessFields;
  warnings: string[];
} {
  const ogTitle = metaContent(html, "og:title");
  const ogSite = metaContent(html, "og:site_name");
  const ogDesc = metaContent(html, "og:description") || metaContent(html, "description");
  const title = titleText(html);
  const textSample = stripTags(html).slice(0, 4000);
  const corpus = [ogTitle, ogSite, ogDesc, title, textSample].filter(Boolean).join(" \n ");

  const fields: ImportedBusinessFields = {};
  const warnings: string[] = [];

  const businessName = guessBusinessName(url, ogSite, ogTitle || title);
  if (businessName) fields.businessName = businessName;
  else warnings.push("Couldn’t detect a clear business name.");

  const industry = guessIndustry(corpus);
  if (industry) fields.industry = industry;
  else warnings.push("Couldn’t confidently map an industry — pick one manually.");

  if (ogDesc && ogDesc.length >= 4) {
    fields.offerings = ogDesc.slice(0, 2000);
  } else if (textSample.length >= 40) {
    fields.offerings = textSample.slice(0, 400);
    warnings.push("Offerings were inferred from page text — edit before generating.");
  } else {
    warnings.push("No product/service description found on the page.");
  }

  return { fields, warnings };
}

/**
 * Import approved business context from a public website URL.
 * LinkedIn URLs are rejected with a clear recovery path (use a company website).
 */
export async function importBusinessContextFromUrl(input: {
  userId: string;
  businessId: string;
  url: string;
  consent: boolean;
}): Promise<BusinessContextImportResult> {
  if (!input.consent) {
    throw new BusinessContextImportError(
      "consent_required",
      "Confirm consent to import public business details before continuing."
    );
  }

  const url = normalizeUrl(input.url);
  const source = detectSource(url);

  if (source === "linkedin") {
    throw new BusinessContextImportError(
      "linkedin_unsupported",
      "LinkedIn profile import isn’t available yet. Use your company website URL instead, or fill the fields manually."
    );
  }

  const html = await fetchHtml(url);
  const parsed = parseWebsiteHtml(url, html);
  const { fields, rejected } = validateFields(parsed.fields);
  const warnings = [...parsed.warnings];
  if (rejected.length) {
    warnings.push(`Some detected fields were invalid and were dropped: ${rejected.join(", ")}.`);
  }

  const fieldCount = Object.keys(fields).length;
  if (fieldCount === 0) {
    throw new BusinessContextImportError(
      "empty_page",
      "We couldn’t extract usable business details. Try another public page, or enter details manually."
    );
  }

  const partial = fieldCount < 3 || warnings.length > 0;

  await logAccountAudit({
    userId: input.userId,
    businessId: input.businessId,
    action: "business.context_import",
    actor: "user",
    reference: url.toString(),
    metadata: {
      source: "website",
      fields: Object.keys(fields),
      partial,
      warningCount: warnings.length,
    },
  });

  return {
    source: "website",
    sourceUrl: url.toString(),
    sourceLabel: url.hostname.replace(/^www\./i, ""),
    fields,
    partial,
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}

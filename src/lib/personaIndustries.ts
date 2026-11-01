/** Must stay aligned with convert-tide `personaWizardOptions.industryOptions`. */
export const SUPPORTED_INDUSTRIES = [
  "Technology",
  "Beauty & Personal Care",
  "Retail",
  "E-commerce",
  "Fashion & Apparel",
  "Food & Beverage",
  "Health & Wellness",
  "Home & Lifestyle",
  "Other",
] as const;

export type SupportedIndustry = (typeof SUPPORTED_INDUSTRIES)[number];

export function isSupportedIndustry(value: string): value is SupportedIndustry {
  return (SUPPORTED_INDUSTRIES as readonly string[]).includes(value);
}

/**
 * Industry-specific required-field checks beyond the base schema.
 * Returns a human-readable message or null when valid.
 */
export function industryRequiredFieldsMessage(input: {
  industry: string;
  offerings: string;
  targetCustomers: string[];
  priceRange: string;
  marketingGoals: string[];
  challenges: string[];
}): string | null {
  if (!isSupportedIndustry(input.industry)) {
    return `Industry must be one of: ${SUPPORTED_INDUSTRIES.join(", ")}.`;
  }

  const offerings = input.offerings.trim();

  // Product-led industries need a slightly richer offerings description.
  if (
    (input.industry === "Technology" || input.industry === "Health & Wellness") &&
    offerings.length < 8
  ) {
    return (
      input.industry === "Technology"
        ? "Describe your product or platform in a bit more detail (at least a short phrase)."
        : "Describe your health or wellness offering in a bit more detail (at least a short phrase)."
    );
  }

  // Catalog industries should name what is sold.
  if (
    (input.industry === "E-commerce" ||
      input.industry === "Retail" ||
      input.industry === "Fashion & Apparel" ||
      input.industry === "Beauty & Personal Care" ||
      input.industry === "Food & Beverage" ||
      input.industry === "Home & Lifestyle") &&
    offerings.length < 4
  ) {
    return "Tell us what you sell — a short product description is required for this industry.";
  }

  return null;
}

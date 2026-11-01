/**
 * Privacy / merge invariants for business-context import.
 * Run: node scripts/business-context-import-privacy.mjs
 */
import assert from "node:assert/strict";

function isEmpty(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return !String(value).trim();
}

function mergeProfileFields(current, imported) {
  const patch = {};
  if (imported.businessName && isEmpty(current.name)) patch.name = imported.businessName;
  if (imported.industry && isEmpty(current.industry)) patch.industry = imported.industry;
  return patch;
}

assert.deepEqual(
  mergeProfileFields(
    { name: "User Co", industry: "Technology" },
    { businessName: "Scraped Inc", industry: "Retail" }
  ),
  {},
  "must not overwrite filled profile fields"
);

assert.deepEqual(
  mergeProfileFields({ name: "", industry: "" }, { businessName: "Scraped Inc", industry: "Retail" }),
  { name: "Scraped Inc", industry: "Retail" }
);

assert.deepEqual(
  mergeProfileFields(
    { name: "User Co", industry: "" },
    { businessName: "Scraped Inc", industry: "Retail" }
  ),
  { industry: "Retail" },
  "only empty fields may receive import"
);

console.log("businessContextImport privacy checks passed");

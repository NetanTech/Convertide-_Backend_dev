import { supabaseAdmin } from "../config/supabase";

export type PersonaSnapshot = {
  name: string;
  confidence: number;
  confidence_label: string;
  confidence_summary: string;
  demographics: unknown;
  psychographics: unknown;
  pain_points: unknown;
  goals: unknown;
  buying_triggers: unknown;
  objections: unknown;
  platform_preferences: unknown;
  onboarding_input: unknown;
};

export type PersonaVersionSummary = {
  id: string;
  personaId: string;
  versionNumber: number;
  reason: string;
  createdAt: string;
  name: string;
  confidence: number;
  confidenceLabel: string;
};

export type PersonaVersionDetail = PersonaVersionSummary & {
  snapshot: PersonaSnapshot;
};

type VersionRow = {
  id: string;
  persona_id: string;
  user_id: string;
  version_number: number;
  reason: string;
  snapshot: PersonaSnapshot;
  created_at: string;
};

const SNAPSHOT_KEYS: (keyof PersonaSnapshot)[] = [
  "name",
  "confidence",
  "confidence_label",
  "confidence_summary",
  "demographics",
  "psychographics",
  "pain_points",
  "goals",
  "buying_triggers",
  "objections",
  "platform_preferences",
  "onboarding_input",
];

export function snapshotFromPersonaRow(row: Record<string, unknown>): PersonaSnapshot {
  const snap: PersonaSnapshot = {
    name: String(row.name ?? ""),
    confidence: Number(row.confidence ?? 0),
    confidence_label: String(row.confidence_label ?? ""),
    confidence_summary: String(row.confidence_summary ?? ""),
    demographics: row.demographics ?? [],
    psychographics: row.psychographics ?? [],
    pain_points: row.pain_points ?? [],
    goals: row.goals ?? [],
    buying_triggers: row.buying_triggers ?? [],
    objections: row.objections ?? [],
    platform_preferences: row.platform_preferences ?? [],
    onboarding_input: row.onboarding_input ?? null,
  };
  return snap;
}

function toSummary(row: VersionRow): PersonaVersionSummary {
  const snap = row.snapshot ?? ({} as PersonaSnapshot);
  return {
    id: row.id,
    personaId: row.persona_id,
    versionNumber: row.version_number,
    reason: row.reason,
    createdAt: row.created_at,
    name: snap.name ?? "",
    confidence: Number(snap.confidence ?? 0),
    confidenceLabel: snap.confidence_label ?? "",
  };
}

/** Save the current persona row as a new version before it is overwritten. */
export async function savePersonaVersion(input: {
  userId: string;
  personaId: string;
  row: Record<string, unknown>;
  reason: "edit" | "regenerate" | "restore" | string;
}): Promise<PersonaVersionSummary> {
  const { data: latest, error: latestError } = await supabaseAdmin
    .from("persona_versions")
    .select("version_number")
    .eq("persona_id", input.personaId)
    .eq("user_id", input.userId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestError) throw new Error(latestError.message);

  const nextNumber = ((latest as { version_number?: number } | null)?.version_number ?? 0) + 1;
  const snapshot = snapshotFromPersonaRow(input.row);

  const { data, error } = await supabaseAdmin
    .from("persona_versions")
    .insert({
      persona_id: input.personaId,
      user_id: input.userId,
      version_number: nextNumber,
      reason: input.reason,
      snapshot,
    })
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message || "Failed to save persona version");
  return toSummary(data as VersionRow);
}

export async function listPersonaVersions(
  userId: string,
  personaId: string
): Promise<PersonaVersionSummary[]> {
  const { data, error } = await supabaseAdmin
    .from("persona_versions")
    .select("id, persona_id, user_id, version_number, reason, snapshot, created_at")
    .eq("user_id", userId)
    .eq("persona_id", personaId)
    .order("version_number", { ascending: false });

  if (error) throw new Error(error.message);
  return ((data ?? []) as VersionRow[]).map(toSummary);
}

export async function getPersonaVersion(
  userId: string,
  personaId: string,
  versionId: string
): Promise<PersonaVersionDetail | null> {
  const { data, error } = await supabaseAdmin
    .from("persona_versions")
    .select("*")
    .eq("user_id", userId)
    .eq("persona_id", personaId)
    .eq("id", versionId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const row = data as VersionRow;
  return {
    ...toSummary(row),
    snapshot: row.snapshot,
  };
}

/** Apply a stored snapshot back onto the live persona row (caller should snapshot current first). */
export function updatesFromSnapshot(snapshot: PersonaSnapshot): Record<string, unknown> {
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  for (const key of SNAPSHOT_KEYS) {
    updates[key] = snapshot[key];
  }
  return updates;
}

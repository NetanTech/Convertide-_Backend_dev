import { supabaseAdmin } from "../config/supabase";

export type PlanSnapshot = {
  name: string;
  status: string;
  persona_id: string | null;
  campaign_id: string | null;
  persona_snapshot: unknown;
  campaign_snapshot: unknown;
  budget: string;
  timeline: unknown;
  channel_mix: unknown;
  weekly_action_plan: unknown;
  content_calendar: unknown;
  kpis: unknown;
  expected_outcome: unknown;
  progress: number;
};

export type PlanVersionSummary = {
  id: string;
  planId: string;
  versionNumber: number;
  reason: string;
  createdAt: string;
  name: string;
  progress: number;
  status: string;
};

export type PlanVersionDetail = PlanVersionSummary & {
  snapshot: PlanSnapshot;
};

type VersionRow = {
  id: string;
  plan_id: string;
  user_id: string;
  version_number: number;
  reason: string;
  snapshot: PlanSnapshot;
  created_at: string;
};

const SNAPSHOT_KEYS: (keyof PlanSnapshot)[] = [
  "name",
  "status",
  "persona_id",
  "campaign_id",
  "persona_snapshot",
  "campaign_snapshot",
  "budget",
  "timeline",
  "channel_mix",
  "weekly_action_plan",
  "content_calendar",
  "kpis",
  "expected_outcome",
  "progress",
];

export function snapshotFromPlanRow(row: Record<string, unknown>): PlanSnapshot {
  return {
    name: String(row.name ?? ""),
    status: String(row.status ?? "Active"),
    persona_id: (row.persona_id as string | null) ?? null,
    campaign_id: (row.campaign_id as string | null) ?? null,
    persona_snapshot: row.persona_snapshot ?? {},
    campaign_snapshot: row.campaign_snapshot ?? {},
    budget: String(row.budget ?? ""),
    timeline: row.timeline ?? {},
    channel_mix: row.channel_mix ?? [],
    weekly_action_plan: row.weekly_action_plan ?? [],
    content_calendar: row.content_calendar ?? [],
    kpis: row.kpis ?? [],
    expected_outcome: row.expected_outcome ?? [],
    progress: Number(row.progress ?? 0),
  };
}

function toSummary(row: VersionRow): PlanVersionSummary {
  const snap = row.snapshot ?? ({} as PlanSnapshot);
  return {
    id: row.id,
    planId: row.plan_id,
    versionNumber: row.version_number,
    reason: row.reason,
    createdAt: row.created_at,
    name: snap.name ?? "",
    progress: Number(snap.progress ?? 0),
    status: snap.status ?? "Active",
  };
}

export async function savePlanVersion(input: {
  userId: string;
  planId: string;
  row: Record<string, unknown>;
  reason: "edit" | "restore" | string;
}): Promise<PlanVersionSummary> {
  const { data: latest, error: latestError } = await supabaseAdmin
    .from("plan_versions")
    .select("version_number")
    .eq("plan_id", input.planId)
    .eq("user_id", input.userId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestError) throw new Error(latestError.message);

  const nextNumber = ((latest as { version_number?: number } | null)?.version_number ?? 0) + 1;
  const snapshot = snapshotFromPlanRow(input.row);

  const { data, error } = await supabaseAdmin
    .from("plan_versions")
    .insert({
      plan_id: input.planId,
      user_id: input.userId,
      version_number: nextNumber,
      reason: input.reason,
      snapshot,
    })
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message || "Failed to save plan version");
  return toSummary(data as VersionRow);
}

export async function listPlanVersions(
  userId: string,
  planId: string
): Promise<PlanVersionSummary[]> {
  const { data, error } = await supabaseAdmin
    .from("plan_versions")
    .select("id, plan_id, user_id, version_number, reason, snapshot, created_at")
    .eq("user_id", userId)
    .eq("plan_id", planId)
    .order("version_number", { ascending: false });

  if (error) throw new Error(error.message);
  return ((data ?? []) as VersionRow[]).map(toSummary);
}

export async function getPlanVersion(
  userId: string,
  planId: string,
  versionId: string
): Promise<PlanVersionDetail | null> {
  const { data, error } = await supabaseAdmin
    .from("plan_versions")
    .select("*")
    .eq("user_id", userId)
    .eq("plan_id", planId)
    .eq("id", versionId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const row = data as VersionRow;
  return { ...toSummary(row), snapshot: row.snapshot };
}

export function updatesFromPlanSnapshot(
  snapshot: PlanSnapshot,
  options?: { preserveProgress?: number }
): Record<string, unknown> {
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  for (const key of SNAPSHOT_KEYS) {
    updates[key] = snapshot[key];
  }
  if (options?.preserveProgress !== undefined) {
    updates.progress = options.preserveProgress;
  }
  return updates;
}

/** True when the patch touches substantive plan content (not just progress/status/name). */
export function isContentRevision(body: Record<string, unknown>): boolean {
  return (
    body.budget !== undefined ||
    body.timeline !== undefined ||
    body.channelMix !== undefined ||
    body.weeklyActionPlan !== undefined ||
    body.contentCalendar !== undefined ||
    body.kpis !== undefined ||
    body.expectedOutcome !== undefined
  );
}

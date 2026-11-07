import { createHash } from "node:crypto";
import { supabaseAdmin } from "../config/supabase";
import { executeDirectPublish, normalizeEmailRecipients } from "./campaignPublish";
import { isDemoMode } from "./integrations";
import { isEmailConfigured } from "./mailer";

export type WeeklyPlatform = "meta" | "email";

type PlanScheduleRow = {
  id: string;
  user_id: string;
  business_id: string | null;
  campaign_id: string | null;
  name: string;
  content_calendar: unknown;
  weekly_posting_enabled: boolean;
  weekly_posting_platforms: string[] | null;
  weekly_posting_hour_utc: number | null;
  weekly_posting_recipients: string[] | null;
};

type CampaignTabItem = {
  text?: string;
  score?: number;
  format?: string;
};

type CampaignRow = {
  id: string;
  name: string;
  tabs: Array<{
    label?: string;
    platform?: string;
    items?: CampaignTabItem[];
  }> | null;
};

function hashText(text: string) {
  return createHash("sha256").update(text.trim().toLowerCase()).digest("hex").slice(0, 24);
}

function calendarPlatformFor(channel: WeeklyPlatform): string[] {
  if (channel === "email") return ["email"];
  return ["facebook", "instagram", "meta"];
}

function focusForWeekday(
  contentCalendar: unknown,
  channel: WeeklyPlatform,
  weekday: number
): string {
  const rows = Array.isArray(contentCalendar) ? contentCalendar : [];
  const wanted = calendarPlatformFor(channel);
  const row = rows.find((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const platform = String((raw as { platform?: string }).platform ?? "").toLowerCase();
    return wanted.includes(platform);
  }) as { days?: string[]; format?: string } | undefined;

  const days = Array.isArray(row?.days) ? row!.days! : [];
  const label = String(days[weekday] ?? row?.format ?? "").trim();
  if (label) return label;
  return channel === "email" ? "Email copy" : "Post copy";
}

function preferredFormats(focusLabel: string): string[] {
  const f = focusLabel.toLowerCase();
  if (/headline/.test(f)) return ["headline"];
  if (/cta|button/.test(f)) return ["cta"];
  if (/hook|script|trend/.test(f)) return ["hook", "short"];
  if (/subject/.test(f)) return ["headline"];
  if (/preview/.test(f)) return ["short"];
  if (/body|nurture|offer|digest/.test(f)) return ["long", "short"];
  if (/caption|feed|story|engagement|comment|carousel|reply/.test(f)) return ["short", "long"];
  return ["short", "long", "headline", "hook", "cta"];
}

function pickTab(campaign: CampaignRow, channel: WeeklyPlatform) {
  const tabs = Array.isArray(campaign.tabs) ? campaign.tabs : [];
  if (channel === "email") {
    return (
      tabs.find((t) => /email/i.test(`${t.platform ?? ""} ${t.label ?? ""}`)) || tabs[0] || null
    );
  }
  return (
    tabs.find((t) => /meta|facebook|instagram/i.test(`${t.platform ?? ""} ${t.label ?? ""}`)) ||
    tabs[0] ||
    null
  );
}

export function buildSlotCopy(input: {
  campaign: CampaignRow;
  channel: WeeklyPlatform;
  focusLabel: string;
  usedKeys: Set<string>;
}): { headlines: string[]; primaryText: string; copyItemKeys: string[] } {
  const tab = pickTab(input.campaign, input.channel);
  const items = Array.isArray(tab?.items) ? [...tab!.items!] : [];
  const formats = preferredFormats(input.focusLabel);

  const scored = items
    .map((item) => ({
      text: String(item.text ?? "").trim(),
      score: Number(item.score ?? 0),
      format: String(item.format ?? "").toLowerCase(),
      key: hashText(String(item.text ?? "")),
    }))
    .filter((i) => i.text);

  const unused = scored.filter((i) => !input.usedKeys.has(i.key));
  const pool =
    unused.filter((i) => !i.format || formats.includes(i.format)).sort((a, b) => b.score - a.score) ||
    [];
  const fallback = unused.sort((a, b) => b.score - a.score);
  const ordered = pool.length ? pool : fallback;

  const primary = ordered[0]?.text || `${input.campaign.name} · ${input.focusLabel}`;
  const primaryKey = ordered[0]?.key || hashText(primary);
  input.usedKeys.add(primaryKey);

  const extras: string[] = [];
  const keys = [primaryKey];
  for (const item of ordered.slice(1)) {
    if (extras.length >= 2) break;
    if (input.usedKeys.has(item.key)) continue;
    extras.push(item.text);
    keys.push(item.key);
    input.usedKeys.add(item.key);
  }

  return {
    primaryText: `[${input.focusLabel}] ${primary}`,
    headlines: [primary, ...extras].slice(0, 3),
    copyItemKeys: keys,
  };
}

async function assertChannelReady(userId: string, channel: WeeklyPlatform) {
  if (channel === "email") {
    if (!isEmailConfigured()) {
      throw new Error("Email posting needs ZeptoMail configured on the server.");
    }
    return;
  }
  const { data, error } = await supabaseAdmin
    .from("user_integrations")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "connected")
    .in("provider", ["facebook", "instagram"])
    .limit(1);
  if (error) throw new Error(error.message);
  if ((!data || data.length === 0) && !isDemoMode()) {
    throw new Error("Connect a Facebook Page before enabling Meta weekly posting.");
  }
}

function nextDueDates(hourUtc: number, count = 7): Array<{ dueAt: Date; weekday: number }> {
  const out: Array<{ dueAt: Date; weekday: number }> = [];
  const now = new Date();
  for (let offset = 0; offset < count + 3 && out.length < count; offset += 1) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset, hourUtc, 0, 0, 0)
    );
    if (d.getTime() <= now.getTime() + 60_000) continue;
    // JS: 0=Sun … convert to Mon=0 … Sun=6
    const jsDay = d.getUTCDay();
    const weekday = jsDay === 0 ? 6 : jsDay - 1;
    out.push({ dueAt: d, weekday });
  }
  return out;
}

async function loadCampaign(userId: string, businessId: string, campaignId: string) {
  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .select("id, name, tabs")
    .eq("user_id", userId)
    .eq("business_id", businessId)
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Linked campaign not found.");
  return data as CampaignRow;
}

async function enqueueSlots(plan: PlanScheduleRow, platforms: WeeklyPlatform[], hourUtc: number) {
  if (!plan.campaign_id || !plan.business_id) {
    throw new Error("This plan needs a linked campaign before weekly posting.");
  }
  const campaign = await loadCampaign(plan.user_id, plan.business_id, plan.campaign_id);
  const recipients = normalizeEmailRecipients(plan.weekly_posting_recipients);
  const dues = nextDueDates(hourUtc, 7);

  for (const platform of platforms) {
    const usedKeys = new Set<string>();
    const { data: existing } = await supabaseAdmin
      .from("scheduled_publishes")
      .select("payload")
      .eq("plan_id", plan.id)
      .eq("platform", platform)
      .in("status", ["pending", "publishing", "published"])
      .gte("due_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    for (const row of existing ?? []) {
      const keys = (row as { payload?: { copyItemKeys?: string[] } }).payload?.copyItemKeys ?? [];
      for (const key of keys) usedKeys.add(key);
    }

    for (const slot of dues) {
      const focusLabel = focusForWeekday(plan.content_calendar, platform, slot.weekday);
      const copy = buildSlotCopy({
        campaign,
        channel: platform,
        focusLabel,
        usedKeys,
      });

      const dueAt = slot.dueAt.toISOString();
      const { data: existingSlot } = await supabaseAdmin
        .from("scheduled_publishes")
        .select("id")
        .eq("plan_id", plan.id)
        .eq("platform", platform)
        .eq("due_at", dueAt)
        .in("status", ["pending", "publishing"])
        .maybeSingle();
      if (existingSlot) continue;

      const { error } = await supabaseAdmin.from("scheduled_publishes").insert({
        user_id: plan.user_id,
        business_id: plan.business_id,
        plan_id: plan.id,
        campaign_id: plan.campaign_id,
        platform,
        due_at: dueAt,
        weekday: slot.weekday,
        focus_label: focusLabel,
        status: "pending",
        payload: {
          headlines: copy.headlines,
          primaryText: copy.primaryText,
          campaignName: campaign.name,
          recipients: platform === "email" ? recipients : [],
          copyItemKeys: copy.copyItemKeys,
          focusLabel,
        },
      });
      if (error && !/duplicate|unique/i.test(error.message)) {
        throw new Error(error.message);
      }
    }
  }
}

export async function getWeeklyPostingStatus(input: {
  userId: string;
  businessId: string;
  planId: string;
}) {
  const { data: plan, error } = await supabaseAdmin
    .from("plans")
    .select(
      "id, campaign_id, weekly_posting_enabled, weekly_posting_platforms, weekly_posting_hour_utc, weekly_posting_recipients"
    )
    .eq("id", input.planId)
    .eq("user_id", input.userId)
    .eq("business_id", input.businessId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!plan) throw new Error("Plan not found");

  const { data: slots } = await supabaseAdmin
    .from("scheduled_publishes")
    .select("id, platform, due_at, weekday, focus_label, status, error_message")
    .eq("plan_id", input.planId)
    .in("status", ["pending", "publishing", "published", "failed"])
    .order("due_at", { ascending: true })
    .limit(21);

  const p = plan as {
    campaign_id: string | null;
    weekly_posting_enabled: boolean;
    weekly_posting_platforms: string[] | null;
    weekly_posting_hour_utc: number | null;
    weekly_posting_recipients: string[] | null;
  };

  return {
    enabled: Boolean(p.weekly_posting_enabled),
    campaignId: p.campaign_id,
    platforms: (p.weekly_posting_platforms ?? []).filter(
      (x): x is WeeklyPlatform => x === "meta" || x === "email"
    ),
    hourUtc: p.weekly_posting_hour_utc ?? 9,
    recipients: p.weekly_posting_recipients ?? [],
    slots: (slots ?? []).map((s) => {
      const row = s as {
        id: string;
        platform: string;
        due_at: string;
        weekday: number;
        focus_label: string;
        status: string;
        error_message: string | null;
      };
      return {
        id: row.id,
        platform: row.platform,
        dueAt: row.due_at,
        weekday: row.weekday,
        focusLabel: row.focus_label,
        status: row.status,
        errorMessage: row.error_message,
      };
    }),
  };
}

export async function enableWeeklyPosting(input: {
  userId: string;
  businessId: string;
  planId: string;
  platforms: WeeklyPlatform[];
  hourUtc: number;
  recipients?: string[];
}) {
  const platforms = [...new Set(input.platforms)].filter(
    (p): p is WeeklyPlatform => p === "meta" || p === "email"
  );
  if (platforms.length === 0) {
    throw new Error("Choose at least one channel: Meta or Email.");
  }
  const hourUtc = Math.min(23, Math.max(0, Math.round(input.hourUtc)));
  const recipients = normalizeEmailRecipients(input.recipients);
  if (platforms.includes("email") && recipients.length === 0) {
    throw new Error("Add at least one email recipient.");
  }

  for (const platform of platforms) {
    await assertChannelReady(input.userId, platform);
  }

  const { data: plan, error } = await supabaseAdmin
    .from("plans")
    .select("*")
    .eq("id", input.planId)
    .eq("user_id", input.userId)
    .eq("business_id", input.businessId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!plan) throw new Error("Plan not found");
  const row = plan as PlanScheduleRow;
  if (!row.campaign_id) {
    throw new Error("Link a campaign to this plan before scheduling weekly posts.");
  }

  const { error: updateError } = await supabaseAdmin
    .from("plans")
    .update({
      weekly_posting_enabled: true,
      weekly_posting_platforms: platforms,
      weekly_posting_hour_utc: hourUtc,
      weekly_posting_recipients: recipients,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.planId)
    .eq("user_id", input.userId)
    .eq("business_id", input.businessId);

  if (updateError) {
    if (/weekly_posting|schema cache|does not exist/i.test(updateError.message)) {
      throw new Error(
        "Weekly posting columns missing. Run migrations/026_scheduled_publishes.sql in Supabase."
      );
    }
    throw new Error(updateError.message);
  }

  const refreshed = {
    ...row,
    weekly_posting_enabled: true,
    weekly_posting_platforms: platforms,
    weekly_posting_hour_utc: hourUtc,
    weekly_posting_recipients: recipients,
  };
  await enqueueSlots(refreshed, platforms, hourUtc);
  return getWeeklyPostingStatus(input);
}

export async function disableWeeklyPosting(input: {
  userId: string;
  businessId: string;
  planId: string;
}) {
  const { error } = await supabaseAdmin
    .from("plans")
    .update({
      weekly_posting_enabled: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.planId)
    .eq("user_id", input.userId)
    .eq("business_id", input.businessId);
  if (error) throw new Error(error.message);

  await supabaseAdmin
    .from("scheduled_publishes")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("plan_id", input.planId)
    .eq("status", "pending");

  return getWeeklyPostingStatus(input);
}

export async function refillRollingWeek() {
  const { data: plans, error } = await supabaseAdmin
    .from("plans")
    .select("*")
    .eq("weekly_posting_enabled", true);
  if (error) {
    if (/weekly_posting|schema cache|does not exist/i.test(error.message)) return { refilled: 0 };
    throw new Error(error.message);
  }

  let refilled = 0;
  for (const raw of plans ?? []) {
    const plan = raw as PlanScheduleRow;
    const platforms = (plan.weekly_posting_platforms ?? []).filter(
      (p): p is WeeklyPlatform => p === "meta" || p === "email"
    );
    if (!platforms.length || !plan.campaign_id) continue;
    try {
      await enqueueSlots(plan, platforms, plan.weekly_posting_hour_utc ?? 9);
      refilled += 1;
    } catch (err) {
      console.warn(
        "[scheduled-publish] refill failed",
        plan.id,
        err instanceof Error ? err.message : err
      );
    }
  }
  return { refilled };
}

export async function processDueScheduledPublishes() {
  const nowIso = new Date().toISOString();
  const { data: due, error } = await supabaseAdmin
    .from("scheduled_publishes")
    .select("*")
    .eq("status", "pending")
    .lte("due_at", nowIso)
    .order("due_at", { ascending: true })
    .limit(25);

  if (error) {
    if (/scheduled_publishes|schema cache|does not exist/i.test(error.message)) {
      return { processed: 0, published: 0, failed: 0 };
    }
    throw new Error(error.message);
  }

  let published = 0;
  let failed = 0;

  for (const raw of due ?? []) {
    const slot = raw as {
      id: string;
      user_id: string;
      business_id: string;
      plan_id: string;
      campaign_id: string;
      platform: WeeklyPlatform;
      payload: {
        headlines?: string[];
        primaryText?: string;
        campaignName?: string;
        recipients?: string[];
      };
    };

    const { data: plan } = await supabaseAdmin
      .from("plans")
      .select("weekly_posting_enabled")
      .eq("id", slot.plan_id)
      .maybeSingle();
    if (!(plan as { weekly_posting_enabled?: boolean } | null)?.weekly_posting_enabled) {
      await supabaseAdmin
        .from("scheduled_publishes")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", slot.id);
      continue;
    }

    await supabaseAdmin
      .from("scheduled_publishes")
      .update({ status: "publishing", updated_at: new Date().toISOString() })
      .eq("id", slot.id)
      .eq("status", "pending");

    try {
      const result = await executeDirectPublish({
        userId: slot.user_id,
        businessId: slot.business_id,
        campaignId: slot.campaign_id,
        platform: slot.platform,
        campaignName: slot.payload.campaignName || "Convert Tide campaign",
        headlines: slot.payload.headlines || [],
        primaryText: slot.payload.primaryText || "",
        recipients: slot.payload.recipients,
        idempotencyKey: `sched:${slot.id}`,
      });
      await supabaseAdmin
        .from("scheduled_publishes")
        .update({
          status: "published",
          publish_id: result.publishId,
          updated_at: new Date().toISOString(),
          error_message: null,
        })
        .eq("id", slot.id);
      published += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Publish failed";
      await supabaseAdmin
        .from("scheduled_publishes")
        .update({
          status: "failed",
          error_message: message.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq("id", slot.id);
      failed += 1;
    }
  }

  return { processed: (due ?? []).length, published, failed };
}

const INTERVAL_MS = 5 * 60 * 1000;

export function startScheduledPublishScheduler() {
  const run = () => {
    void (async () => {
      try {
        await refillRollingWeek();
        const result = await processDueScheduledPublishes();
        if (result.published || result.failed) {
          console.log(
            `[scheduled-publish] processed=${result.processed} published=${result.published} failed=${result.failed}`
          );
        }
      } catch (err) {
        console.error("[scheduled-publish] sweep error", err);
      }
    })();
  };

  setTimeout(run, 20_000);
  setInterval(run, INTERVAL_MS);
}

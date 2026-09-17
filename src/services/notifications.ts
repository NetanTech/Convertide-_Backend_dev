import { supabaseAdmin } from "../config/supabase";
import type { CreateNotificationInput } from "../schemas/notification.schema";
import { ensureUserSettings } from "./settings";
import { sendNotificationEmail } from "./notificationEmail";

type NotificationRow = {
  id: string;
  user_id: string;
  category: "campaigns" | "ai" | "billing";
  title: string;
  description: string;
  action_label: string;
  action_href: string;
  action_tone: "primary" | "warning" | "insight" | "neutral";
  unread: boolean;
  dismissed_at: string | null;
  created_at: string;
};

export function toNotification(row: NotificationRow) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    description: row.description,
    time: row.created_at,
    actionLabel: row.action_label,
    actionHref: row.action_href,
    actionTone: row.action_tone,
    unread: row.unread,
  };
}

export async function countUnreadNotifications(userId: string) {
  const { count, error } = await supabaseAdmin
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("unread", true)
    .is("dismissed_at", null);

  if (error) throw new Error(error.message);
  return count ?? 0;
}

function buildListQuery(
  userId: string,
  options?: { category?: string; includeDismissed?: boolean }
) {
  let query = supabaseAdmin
    .from("notifications")
    .select("*", { count: "exact" })
    .eq("user_id", userId);

  if (!options?.includeDismissed) {
    query = query.is("dismissed_at", null);
  }
  if (options?.category && options.category !== "all") {
    query = query.eq("category", options.category);
  }

  return query;
}

async function resolveHighlightPage(
  userId: string,
  highlightId: string,
  limit: number,
  category?: string
) {
  const { data: highlighted, error } = await supabaseAdmin
    .from("notifications")
    .select("id, category, created_at")
    .eq("user_id", userId)
    .eq("id", highlightId)
    .is("dismissed_at", null)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!highlighted) return null;

  let countQuery = supabaseAdmin
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("dismissed_at", null)
    .gt("created_at", highlighted.created_at);

  if (category && category !== "all") {
    countQuery = countQuery.eq("category", category);
  }

  const { count, error: countError } = await countQuery;
  if (countError) throw new Error(countError.message);

  return {
    page: Math.floor((count ?? 0) / limit) + 1,
    category: highlighted.category as NotificationRow["category"],
  };
}

export async function listNotifications(
  userId: string,
  options?: {
    category?: string;
    includeDismissed?: boolean;
    page?: number;
    limit?: number;
    highlightId?: string;
  }
) {
  const limit = Math.min(50, Math.max(1, options?.limit ?? 10));
  let page = Math.max(1, options?.page ?? 1);

  if (options?.highlightId) {
    const resolved = await resolveHighlightPage(userId, options.highlightId, limit, options.category);
    if (resolved) {
      page = resolved.page;
    }
  }

  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, error, count } = await buildListQuery(userId, options)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) throw new Error(error.message);

  const total = count ?? 0;
  const unreadCount = await countUnreadNotifications(userId);

  return {
    notifications: (data as NotificationRow[]).map(toNotification),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
    unreadCount,
  };
}

export async function createNotification(userId: string, input: CreateNotificationInput) {
  const settings = await ensureUserSettings(userId);
  const prefs = settings.notifications;

  // Respect user preferences before inserting event-driven notifications.
  if (input.category === "campaigns" && !prefs.campaignGenerated) return null;
  if (input.category === "billing" && !prefs.billingUpdates) return null;
  if (input.category === "ai") {
    const title = input.title.toLowerCase();
    if (title.includes("persona") && !prefs.personaGenerated) return null;
    if (title.includes("credit") && !prefs.aiCreditsLow) return null;
    if (title.includes("plan") && !prefs.marketingPlanGenerated) return null;
  }

  const { data, error } = await supabaseAdmin
    .from("notifications")
    .insert({
      user_id: userId,
      category: input.category,
      title: input.title,
      description: input.description,
      action_label: input.actionLabel,
      action_href: input.actionHref,
      action_tone: input.actionTone,
    })
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message || "Failed to create notification");

  // Mirror to email when the user enabled Email Notification in Settings.
  if (prefs.emailNotification) {
    try {
      await sendNotificationEmail(userId, input);
    } catch (err) {
      console.error("[notifications] email mirror failed", err);
    }
  } else {
    console.info(
      `[notifications] email skipped (emailNotification=off): "${input.title}" for user ${userId}`
    );
  }

  return toNotification(data as NotificationRow);
}

export async function markNotificationRead(userId: string, id: string) {
  const { data, error } = await supabaseAdmin
    .from("notifications")
    .update({ unread: false })
    .eq("user_id", userId)
    .eq("id", id)
    .is("dismissed_at", null)
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  return toNotification(data as NotificationRow);
}

export async function markAllNotificationsRead(userId: string) {
  const { error } = await supabaseAdmin
    .from("notifications")
    .update({ unread: false })
    .eq("user_id", userId)
    .eq("unread", true)
    .is("dismissed_at", null);

  if (error) throw new Error(error.message);
}

export async function dismissNotification(userId: string, id: string) {
  const { data, error } = await supabaseAdmin
    .from("notifications")
    .update({ dismissed_at: new Date().toISOString(), unread: false })
    .eq("user_id", userId)
    .eq("id", id)
    .is("dismissed_at", null)
    .select("id")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return Boolean(data);
}

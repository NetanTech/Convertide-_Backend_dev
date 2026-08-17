import { supabaseAdmin } from "../config/supabase";
import type { CreateNotificationInput } from "../schemas/notification.schema";
import { ensureUserSettings } from "./settings";

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

export async function listNotifications(
  userId: string,
  options?: { category?: string; includeDismissed?: boolean }
) {
  let query = supabaseAdmin
    .from("notifications")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (!options?.includeDismissed) {
    query = query.is("dismissed_at", null);
  }
  if (options?.category && options.category !== "all") {
    query = query.eq("category", options.category);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data as NotificationRow[]).map(toNotification);
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

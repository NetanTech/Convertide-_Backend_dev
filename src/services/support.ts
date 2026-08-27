import { supabaseAdmin } from "../config/supabase";
import { HELP_ARTICLES, HELP_FAQS } from "../content/helpContent";
import type { SupportContactInput, SupportMessageInput } from "../schemas/support.schema";
import { appUrl, sendEmail } from "./mailer";

export type SupportMessageView = {
  id: string;
  role: "user" | "support";
  text: string;
  createdAt: string;
};

export type SupportTicketView = {
  id: string;
  subject: string;
  status: "open" | "closed";
  messages: SupportMessageView[];
};

function supportInbox() {
  return (
    process.env.SUPPORT_INBOX?.trim() ||
    process.env.EMAIL_FROM?.trim() ||
    "support@converttide.com"
  );
}

function bookingUrl() {
  return process.env.SUPPORT_BOOKING_URL?.trim() || "";
}

function publicSupportEmail() {
  return process.env.SUPPORT_PUBLIC_EMAIL?.trim() || supportInbox();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isMissingRelation(message: string) {
  return /relation|does not exist/i.test(message);
}

async function resolveUserEmail(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error || !data?.user?.email) return null;
  return data.user.email;
}

export function getHelpContent() {
  return {
    articles: HELP_ARTICLES,
    faqs: HELP_FAQS,
    bookingUrl: bookingUrl(),
    supportEmail: publicSupportEmail(),
  };
}

async function notifySupportInbox(input: {
  userId: string;
  userEmail: string | null;
  subject: string;
  body: string;
  ticketId?: string;
}) {
  const inbox = supportInbox();
  const fromUser = input.userEmail || input.userId;
  const ticketLine = input.ticketId
    ? `\nTicket: ${input.ticketId}\nDashboard: ${appUrl("/dashboard/settings?tab=help")}`
    : `\nDashboard: ${appUrl("/dashboard/settings?tab=help")}`;

  const text = [
    `New support message from ${fromUser}`,
    `User ID: ${input.userId}`,
    "",
    input.body,
    ticketLine,
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#121212;max-width:560px">
      <h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(input.subject)}</h1>
      <p style="margin:0 0 8px;color:#505050">From: ${escapeHtml(fromUser)}</p>
      <p style="margin:0 0 8px;color:#505050">User ID: ${escapeHtml(input.userId)}</p>
      <p style="margin:16px 0;white-space:pre-wrap">${escapeHtml(input.body)}</p>
      ${
        input.ticketId
          ? `<p style="margin:0;font-size:12px;color:#9A9A9A">Ticket ${escapeHtml(input.ticketId)}</p>`
          : ""
      }
    </div>
  `;

  await sendEmail({
    to: inbox,
    subject: input.subject,
    html,
    text,
  });
}

function mapMessage(row: {
  id: string;
  sender: string;
  body: string;
  created_at: string;
}): SupportMessageView {
  return {
    id: row.id,
    role: row.sender === "support" ? "support" : "user",
    text: row.body,
    createdAt: row.created_at,
  };
}

async function loadTicketMessages(ticketId: string): Promise<SupportMessageView[]> {
  const { data, error } = await supabaseAdmin
    .from("support_messages")
    .select("id, sender, body, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return (data || []).map(mapMessage);
}

export async function getOpenTicket(userId: string): Promise<SupportTicketView | null> {
  const { data: ticket, error } = await supabaseAdmin
    .from("support_tickets")
    .select("id, subject, status")
    .eq("user_id", userId)
    .eq("status", "open")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingRelation(error.message)) {
      throw Object.assign(new Error("Support tables are missing. Run migrations/013_support.sql."), {
        status: 503,
      });
    }
    throw new Error(error.message);
  }

  if (!ticket) return null;

  const messages = await loadTicketMessages(ticket.id);
  return {
    id: ticket.id,
    subject: ticket.subject,
    status: ticket.status as "open" | "closed",
    messages,
  };
}

async function ensureOpenTicket(userId: string, subject = "Support chat"): Promise<string> {
  const existing = await getOpenTicket(userId);
  if (existing) return existing.id;

  const { data, error } = await supabaseAdmin
    .from("support_tickets")
    .insert({ user_id: userId, subject, status: "open" })
    .select("id")
    .single();

  if (error) {
    if (isMissingRelation(error.message)) {
      throw Object.assign(new Error("Support tables are missing. Run migrations/013_support.sql."), {
        status: 503,
      });
    }
    throw new Error(error.message);
  }

  return data.id as string;
}

async function insertMessage(ticketId: string, sender: "user" | "support", body: string) {
  const { data, error } = await supabaseAdmin
    .from("support_messages")
    .insert({ ticket_id: ticketId, sender, body })
    .select("id, sender, body, created_at")
    .single();

  if (error) throw new Error(error.message);
  return mapMessage(data);
}

export async function sendSupportChatMessage(
  userId: string,
  input: SupportMessageInput
): Promise<SupportTicketView> {
  const ticketId = await ensureOpenTicket(userId);
  const userMessage = await insertMessage(ticketId, "user", input.body);

  await supabaseAdmin
    .from("support_tickets")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", ticketId);

  const userEmail = await resolveUserEmail(userId);
  void notifySupportInbox({
    userId,
    userEmail,
    subject: `Support chat from ${userEmail || userId}`,
    body: input.body,
    ticketId,
  });

  const ack =
    "Thanks — we received your message. Our team will follow up by email as soon as we can.";
  const supportMessage = await insertMessage(ticketId, "support", ack);

  const ticket = await getOpenTicket(userId);
  if (!ticket) {
    return {
      id: ticketId,
      subject: "Support chat",
      status: "open",
      messages: [userMessage, supportMessage],
    };
  }
  return ticket;
}

export async function submitSupportContact(userId: string, input: SupportContactInput) {
  const userEmail = await resolveUserEmail(userId);

  // Persist first so the chat thread stays in sync even if mail fails.
  const ticketId = await ensureOpenTicket(userId, input.subject);
  await insertMessage(ticketId, "user", `Subject: ${input.subject}\n\n${input.message}`);
  await insertMessage(
    ticketId,
    "support",
    "Thanks for emailing support. We got your message and will reply soon."
  );
  await supabaseAdmin
    .from("support_tickets")
    .update({ subject: input.subject, updated_at: new Date().toISOString() })
    .eq("id", ticketId);

  await notifySupportInbox({
    userId,
    userEmail,
    subject: `[Help] ${input.subject}`,
    body: input.message,
    ticketId,
  });

  return { ok: true as const, supportEmail: publicSupportEmail() };
}

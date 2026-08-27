import { supabaseAdmin } from "../config/supabase";
import type { CreateNotificationInput } from "../schemas/notification.schema";
import { appUrl, sendEmail } from "./mailer";

async function resolveUserEmail(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error || !data?.user?.email) {
    console.error("[mailer] could not resolve user email", error?.message);
    return null;
  }
  return data.user.email;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Product notification email. Failures are logged and never thrown. */
export async function sendNotificationEmail(userId: string, input: CreateNotificationInput) {
  try {
    const email = await resolveUserEmail(userId);
    if (!email) {
      console.error(`[mailer] no email on auth user ${userId}`);
      return;
    }

    console.info(`[mailer] sending notification email to ${email}: "${input.title}"`);

    const href = input.actionHref ? appUrl(input.actionHref) : appUrl("/dashboard");
    const cta = input.actionLabel || "Open Convert Tide";
    const text = [
      input.title,
      "",
      input.description,
      "",
      `${cta}: ${href}`,
      "",
      "You're receiving this because email notifications are enabled in Settings.",
    ].join("\n");

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#121212;max-width:560px">
        <h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(input.title)}</h1>
        <p style="margin:0 0 20px;color:#505050">${escapeHtml(input.description)}</p>
        <p style="margin:0 0 24px">
          <a href="${href}" style="display:inline-block;background:#91B135;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">
            ${escapeHtml(cta)}
          </a>
        </p>
        <p style="margin:0;font-size:12px;color:#9A9A9A">
          You're receiving this because email notifications are enabled in Settings.
        </p>
      </div>
    `;

    const result = await sendEmail({
      to: email,
      subject: input.title,
      html,
      text,
    });

    if (!result.ok) {
      console.error(`[mailer] notification email did not send to ${email}`);
    }
  } catch (err) {
    console.error("[mailer] notification email failed", err);
  }
}

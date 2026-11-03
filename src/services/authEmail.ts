import { supabaseAdmin } from "../config/supabase";
import { appUrl, sendEmail } from "./mailer";

type AuthMailKind = "recovery" | "signup";

/**
 * Supabase SMTP is failing with "Error sending recovery email" even though
 * custom Zepto SMTP is configured in the dashboard. Generate the OTP via Admin
 * API and deliver it with our working ZeptoMail HTTP mailer instead.
 */
export async function sendAuthCodeEmail(
  email: string,
  kind: AuthMailKind
): Promise<{ sent: boolean; reason?: string }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return { sent: false, reason: "missing_email" };

  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: kind,
    email: normalized,
    options: {
      redirectTo: appUrl(kind === "recovery" ? "/reset-password" : "/verify-email"),
    },
  });

  if (error) {
    console.error(`[auth-email] generateLink(${kind}) failed:`, error.message);
    return { sent: false, reason: error.message };
  }

  const otp = data.properties?.email_otp?.trim();
  if (!otp) {
    console.error(`[auth-email] generateLink(${kind}) returned no email_otp`);
    return { sent: false, reason: "missing_otp" };
  }

  const isRecovery = kind === "recovery";
  const subject = isRecovery
    ? "Your Convert Tide password reset code"
    : "Your Convert Tide verification code";
  const heading = isRecovery ? "Reset your password" : "Verify your email";
  const blurb = isRecovery
    ? "Use this code on the reset password screen. It expires soon."
    : "Use this code to verify your Convert Tide account. It expires soon.";

  const result = await sendEmail({
    to: normalized,
    subject,
    text: `${heading}\n\nYour code is: ${otp}\n\n${blurb}\n`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#121212">
        <h2 style="margin:0 0 12px">${heading}</h2>
        <p style="margin:0 0 16px">${blurb}</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:0 0 16px">${otp}</p>
        <p style="margin:0;color:#6C6C6C;font-size:13px">If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  });

  if (!result.ok) {
    return { sent: false, reason: "zeptomail_send_failed" };
  }

  return { sent: true };
}

import { supabaseAdmin } from "../config/supabase";
import { appUrl, sendEmail } from "./mailer";

/**
 * Supabase SMTP is failing with "Error sending recovery email" even though
 * custom Zepto SMTP is configured in the dashboard. Generate the OTP via Admin
 * API and deliver it with our working ZeptoMail HTTP mailer instead.
 */
export async function sendPasswordResetCodeEmail(
  email: string
): Promise<{ sent: boolean; reason?: string }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return { sent: false, reason: "missing_email" };

  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email: normalized,
    options: {
      redirectTo: appUrl("/reset-password"),
    },
  });

  if (error) {
    console.error("[auth-email] generateLink(recovery) failed:", error.message);
    return { sent: false, reason: error.message };
  }

  const otp = data.properties?.email_otp?.trim();
  if (!otp) {
    console.error("[auth-email] generateLink(recovery) returned no email_otp");
    return { sent: false, reason: "missing_otp" };
  }

  const result = await sendEmail({
    to: normalized,
    subject: "Your Convert Tide password reset code",
    text: `Reset your password\n\nYour code is: ${otp}\n\nUse this code on the reset password screen. It expires soon.\n`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#121212">
        <h2 style="margin:0 0 12px">Reset your password</h2>
        <p style="margin:0 0 16px">Use this code on the reset password screen. It expires soon.</p>
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

/**
 * Start an email change: generate the Supabase email_change OTP for the new
 * address and deliver it via ZeptoMail (same reason as password reset above).
 */
export async function sendEmailChangeCodeEmail(
  currentEmail: string,
  newEmail: string
): Promise<{ sent: boolean; reason?: string }> {
  const current = currentEmail.trim().toLowerCase();
  const next = newEmail.trim().toLowerCase();
  if (!current || !next) return { sent: false, reason: "missing_email" };

  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "email_change_new",
    email: current,
    newEmail: next,
    options: {
      redirectTo: appUrl("/dashboard/settings?tab=account"),
    },
  });

  if (error) {
    console.error("[auth-email] generateLink(email_change_new) failed:", error.message);
    return { sent: false, reason: error.message };
  }

  const otp = data.properties?.email_otp?.trim();
  if (!otp) {
    console.error("[auth-email] generateLink(email_change_new) returned no email_otp");
    return { sent: false, reason: "missing_otp" };
  }

  const result = await sendEmail({
    to: next,
    subject: "Confirm your new Convert Tide email",
    text: `Confirm your email change\n\nYour code is: ${otp}\n\nEnter this code in Settings to finish changing your email. It expires soon.\n`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#121212">
        <h2 style="margin:0 0 12px">Confirm your email change</h2>
        <p style="margin:0 0 16px">Enter this code in Settings to finish changing your email. It expires soon.</p>
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

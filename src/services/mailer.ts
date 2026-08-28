export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

function zeptoApiKey() {
  const raw = process.env.ZEPTOMAIL_API_KEY?.trim() || process.env.SMTP_PASS?.trim() || "";
  if (!raw) return null;
  // Accept either bare token or full "Zoho-enczapikey …" value from the dashboard.
  return raw.replace(/^Zoho-enczapikey\s+/i, "").trim() || null;
}

function fromParts() {
  const address = (process.env.EMAIL_FROM || "noreply@localhost").trim();
  // Support "Name <email@domain>" or bare address
  const match = address.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    return {
      name: match[1].replace(/^["']|["']$/g, "").trim() || process.env.EMAIL_FROM_NAME?.trim() || "Convertide",
      address: match[2].trim(),
    };
  }
  return {
    name: process.env.EMAIL_FROM_NAME?.trim() || "Convertide",
    address,
  };
}

export function isEmailConfigured() {
  return Boolean(zeptoApiKey());
}

function publicAppOrigin(): string {
  const explicit = process.env.APP_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const origins = (process.env.FRONTEND_URL || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  // Prefer a real deployed origin over localhost when FRONTEND_URL lists both (common in dev).
  const nonLocal = origins.find(
    (origin) => !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(origin)
  );
  if (nonLocal) return nonLocal.replace(/\/$/, "");

  return (origins[0] || "http://localhost:3000").replace(/\/$/, "");
}

export function appUrl(path = "/") {
  const base = publicAppOrigin();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}

/**
 * Sends via ZeptoMail HTTP API (what the team provisioned: ZEPTOMAIL_API_KEY).
 * Soft-fails when the key is missing.
 */
export async function sendEmail(input: SendEmailInput): Promise<{ ok: boolean }> {
  const to = input.to.trim();
  if (!to) return { ok: false };

  const apiKey = zeptoApiKey();
  if (!apiKey) {
    console.info(
      `[mailer] skipped (ZEPTOMAIL_API_KEY not configured): to=${to} subject="${input.subject}"`
    );
    return { ok: false };
  }

  const from = fromParts();
  const endpoint = (process.env.ZEPTOMAIL_API_URL || "https://api.zeptomail.com/v1.1/email").trim();

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Zoho-enczapikey ${apiKey}`,
      },
      body: JSON.stringify({
        from: { address: from.address, name: from.name },
        to: [{ email_address: { address: to, name: to } }],
        subject: input.subject,
        htmlbody: input.html,
        ...(input.text ? { textbody: input.text } : {}),
      }),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      console.error(`[mailer] ZeptoMail API ${res.status}: ${bodyText}`);
      return { ok: false };
    }

    console.info(
      `[mailer] sent ok (api): to=${to} from=${from.address} subject="${input.subject}"`
    );
    return { ok: true };
  } catch (err) {
    console.error("[mailer] send failed", err);
    return { ok: false };
  }
}

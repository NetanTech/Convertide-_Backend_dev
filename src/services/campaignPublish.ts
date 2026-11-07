import * as crypto from "node:crypto";
import { supabaseAdmin } from "../config/supabase";
import { logAccountAudit } from "./accountAudit";
import { isDemoMode, type MetaPublishMetadata } from "./integrations";
import { isEmailConfigured, sendEmail } from "./mailer";

const META_GRAPH = "https://graph.facebook.com/v21.0";
const EMAIL_RECIPIENT_LIMIT = 50;

export type PublishPlatform = "meta" | "google_ads" | "email";

type CampaignCopyRow = {
  id: string;
  name: string;
  tabs: Array<{
    label?: string;
    platform?: string;
    items?: Array<{ text?: string; score?: number }>;
  }> | null;
  stats: Record<string, unknown> | null;
};

type IntegrationTokenRow = {
  provider: string;
  account_name: string;
  account_id: string;
  access_token: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
};

export type PublishPreview = {
  platform: PublishPlatform;
  authorized: boolean;
  accountProvider: string | null;
  accountName: string | null;
  connectPath: string;
  campaignId: string;
  campaignName: string;
  headlines: string[];
  primaryText: string;
  previewToken: string;
  previewExpiresAt: string;
  mode: "live" | "demo" | "unauthorized";
};

function previewSecret() {
  return (
    process.env.PUBLISH_PREVIEW_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "convertide-publish-preview-dev"
  );
}

function signPreviewToken(payload: {
  userId: string;
  businessId: string;
  campaignId: string;
  platform: PublishPlatform;
  accountProvider: string | null;
  exp: number;
}) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", previewSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyPreviewToken(
  token: string,
  expected: {
    userId: string;
    businessId: string;
    campaignId: string;
    platform: PublishPlatform;
  }
): { accountProvider: string | null } {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new Error("Invalid preview token");
  const expectedSig = crypto.createHmac("sha256", previewSecret()).update(body).digest("base64url");
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    throw new Error("Invalid preview token signature");
  }
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
    userId?: string;
    businessId?: string;
    campaignId?: string;
    platform?: PublishPlatform;
    accountProvider?: string | null;
    exp?: number;
  };
  if (
    parsed.userId !== expected.userId ||
    parsed.businessId !== expected.businessId ||
    parsed.campaignId !== expected.campaignId ||
    parsed.platform !== expected.platform
  ) {
    throw new Error("Preview token does not match this publish request");
  }
  if (!parsed.exp || parsed.exp < Date.now()) {
    throw new Error("Preview expired — generate a fresh preview before publishing");
  }
  return { accountProvider: parsed.accountProvider ?? null };
}

function pickCopy(
  campaign: CampaignCopyRow,
  platform?: PublishPlatform
): { headlines: string[]; primaryText: string } {
  const tabs = Array.isArray(campaign.tabs) ? campaign.tabs : [];
  const preferred =
    (platform === "email"
      ? tabs.find((t) => /email/i.test(`${t.platform ?? ""} ${t.label ?? ""}`))
      : null) ||
    tabs.find((t) => /meta|facebook|instagram/i.test(`${t.platform ?? ""} ${t.label ?? ""}`)) ||
    tabs[0];
  const items = Array.isArray(preferred?.items) ? preferred!.items! : [];
  const sorted = [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const texts = sorted.map((i) => (i.text || "").trim()).filter(Boolean);
  return {
    headlines: texts.slice(0, 3),
    primaryText: texts[0] || `${campaign.name} - ready to launch.`,
  };
}

export function normalizeEmailRecipients(raw: string[] | undefined | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw ?? []) {
    const email = value.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
    if (out.length >= EMAIL_RECIPIENT_LIMIT) break;
  }
  return out;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildMarketingEmailHtml(input: {
  campaignName: string;
  headlines: string[];
  primaryText: string;
}): { subject: string; html: string; text: string } {
  const subject = (input.headlines[0] || input.campaignName || "Convert Tide campaign").slice(0, 120);
  const bodyLines = [input.primaryText, ...input.headlines.slice(1)].filter(Boolean);
  const paragraphs = bodyLines
    .map((line) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#0d0d0d;">${escapeHtml(line)}</p>`)
    .join("");
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f5f9eb;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e7e7e7;border-radius:12px;padding:24px;">
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:#718a29;">Convert Tide</p>
    <h1 style="margin:0 0 20px;font-size:22px;line-height:1.3;color:#0d0d0d;">${escapeHtml(input.campaignName)}</h1>
    ${paragraphs}
  </div>
</body></html>`;
  const text = [`${input.campaignName}`, "", ...bodyLines].join("\n");
  return { subject, html, text };
}

async function resolveMetaAccount(userId: string): Promise<IntegrationTokenRow | null> {
  const { data, error } = await supabaseAdmin
    .from("user_integrations")
    .select("provider, account_name, account_id, access_token, status, metadata")
    .eq("user_id", userId)
    .eq("status", "connected")
    .in("provider", ["facebook", "instagram"]);

  if (error) throw new Error(error.message);
  const rows = (data ?? []) as IntegrationTokenRow[];
  return rows.find((r) => r.provider === "facebook") || rows[0] || null;
}

async function loadCampaign(
  userId: string,
  businessId: string,
  campaignId: string
): Promise<CampaignCopyRow> {
  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .select("id, name, tabs, stats")
    .eq("user_id", userId)
    .eq("business_id", businessId)
    .eq("id", campaignId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Campaign not found");
  return data as CampaignCopyRow;
}

export async function buildPublishPreview(input: {
  userId: string;
  businessId: string;
  campaignId: string;
  platform: PublishPlatform;
  userEmail?: string | null;
}): Promise<PublishPreview> {
  const campaign = await loadCampaign(input.userId, input.businessId, input.campaignId);
  const copy = pickCopy(campaign, input.platform);
  const connectPath = "/dashboard/settings?tab=integrations";
  const exp = Date.now() + 15 * 60 * 1000;

  if (input.platform === "email") {
    const accountEmail = (input.userEmail || "").trim().toLowerCase();
    const zeptoReady = isEmailConfigured();
    if (!zeptoReady || !accountEmail) {
      return {
        platform: "email",
        authorized: false,
        accountProvider: null,
        accountName: null,
        connectPath: "/dashboard/settings",
        campaignId: campaign.id,
        campaignName: campaign.name,
        headlines: copy.headlines,
        primaryText: copy.primaryText,
        previewToken: "",
        previewExpiresAt: new Date(exp).toISOString(),
        mode: "unauthorized",
      };
    }

    const previewToken = signPreviewToken({
      userId: input.userId,
      businessId: input.businessId,
      campaignId: input.campaignId,
      platform: "email",
      accountProvider: "email",
      exp,
    });

    return {
      platform: "email",
      authorized: true,
      accountProvider: "email",
      accountName: accountEmail,
      connectPath: "/dashboard/settings",
      campaignId: campaign.id,
      campaignName: campaign.name,
      headlines: copy.headlines,
      primaryText: copy.primaryText,
      previewToken,
      previewExpiresAt: new Date(exp).toISOString(),
      mode: "live",
    };
  }

  if (input.platform === "meta") {
    const account = await resolveMetaAccount(input.userId);
    if (!account && !isDemoMode()) {
      return {
        platform: "meta",
        authorized: false,
        accountProvider: null,
        accountName: null,
        connectPath,
        campaignId: campaign.id,
        campaignName: campaign.name,
        headlines: copy.headlines,
        primaryText: copy.primaryText,
        previewToken: "",
        previewExpiresAt: new Date(exp).toISOString(),
        mode: "unauthorized",
      };
    }

    const accountProvider = account?.provider ?? "facebook";
    const metaMeta = metaMetadata(account);
    const accountName =
      (accountProvider === "instagram" && metaMeta?.igUsername
        ? `@${metaMeta.igUsername}`
        : metaMeta?.pageName) ||
      account?.account_name ||
      (isDemoMode() ? "Meta (demo)" : null);
    const previewToken = signPreviewToken({
      userId: input.userId,
      businessId: input.businessId,
      campaignId: input.campaignId,
      platform: "meta",
      accountProvider,
      exp,
    });

    return {
      platform: "meta",
      authorized: true,
      accountProvider,
      accountName,
      connectPath,
      campaignId: campaign.id,
      campaignName: campaign.name,
      headlines: copy.headlines,
      primaryText: copy.primaryText,
      previewToken,
      previewExpiresAt: new Date(exp).toISOString(),
      mode: account?.access_token && !isDemoMode() ? "live" : "demo",
    };
  }

  // Google Ads OAuth is not wired yet — allow demo publish only.
  if (!isDemoMode()) {
    return {
      platform: "google_ads",
      authorized: false,
      accountProvider: null,
      accountName: null,
      connectPath,
      campaignId: campaign.id,
      campaignName: campaign.name,
      headlines: copy.headlines,
      primaryText: copy.primaryText,
      previewToken: "",
      previewExpiresAt: new Date(exp).toISOString(),
      mode: "unauthorized",
    };
  }

  const previewToken = signPreviewToken({
    userId: input.userId,
    businessId: input.businessId,
    campaignId: input.campaignId,
    platform: "google_ads",
    accountProvider: "google_ads",
    exp,
  });

  return {
    platform: "google_ads",
    authorized: true,
    accountProvider: "google_ads",
    accountName: "Google Ads (demo)",
    connectPath,
    campaignId: campaign.id,
    campaignName: campaign.name,
    headlines: copy.headlines,
    primaryText: copy.primaryText,
    previewToken,
    previewExpiresAt: new Date(exp).toISOString(),
    mode: "demo",
  };
}

function metaMetadata(row: IntegrationTokenRow | null): MetaPublishMetadata | null {
  const m = row?.metadata;
  if (!m || typeof m !== "object") return null;
  const pageId = typeof m.pageId === "string" ? m.pageId : "";
  const pageName = typeof m.pageName === "string" ? m.pageName : row?.account_name || "";
  if (!pageId) return null;
  return {
    platform: "meta",
    pageId,
    pageName,
    ...(typeof m.igUserId === "string" ? { igUserId: m.igUserId } : {}),
    ...(typeof m.igUsername === "string" ? { igUsername: m.igUsername } : {}),
    ...(typeof m.userId === "string" ? { userId: m.userId } : {}),
  };
}

async function pushToFacebookPage(input: {
  pageId: string;
  accessToken: string;
  message: string;
}): Promise<{ externalId: string; mode: "live" }> {
  const res = await fetch(
    `${META_GRAPH}/${encodeURIComponent(input.pageId)}/feed`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: input.message.slice(0, 2000),
        access_token: input.accessToken,
      }),
    }
  );
  const json = (await res.json()) as { id?: string; error?: { message?: string } };
  if (!res.ok || !json.id) {
    throw new Error(json.error?.message || `Facebook Page publish failed (${res.status})`);
  }
  return { externalId: json.id, mode: "live" };
}

async function pushToInstagram(input: {
  igUserId: string;
  accessToken: string;
  caption: string;
  imageUrl: string;
}): Promise<{ externalId: string; mode: "live" }> {
  const createUrl = new URL(`${META_GRAPH}/${encodeURIComponent(input.igUserId)}/media`);
  createUrl.searchParams.set("image_url", input.imageUrl);
  createUrl.searchParams.set("caption", input.caption.slice(0, 2200));
  createUrl.searchParams.set("access_token", input.accessToken);

  const createRes = await fetch(createUrl.toString(), { method: "POST" });
  const createJson = (await createRes.json()) as { id?: string; error?: { message?: string } };
  if (!createRes.ok || !createJson.id) {
    throw new Error(createJson.error?.message || `Instagram media create failed (${createRes.status})`);
  }

  const publishUrl = new URL(`${META_GRAPH}/${encodeURIComponent(input.igUserId)}/media_publish`);
  publishUrl.searchParams.set("creation_id", createJson.id);
  publishUrl.searchParams.set("access_token", input.accessToken);

  const publishRes = await fetch(publishUrl.toString(), { method: "POST" });
  const publishJson = (await publishRes.json()) as { id?: string; error?: { message?: string } };
  if (!publishRes.ok || !publishJson.id) {
    throw new Error(publishJson.error?.message || `Instagram publish failed (${publishRes.status})`);
  }
  return { externalId: publishJson.id, mode: "live" };
}

async function pushMetaLive(input: {
  account: IntegrationTokenRow;
  message: string;
  imageUrl?: string | null;
}): Promise<{ externalId: string; mode: "live" }> {
  const token = input.account.access_token;
  if (!token) {
    throw new Error("Connected Meta account is missing an access token. Disconnect and Connect again.");
  }

  const meta = metaMetadata(input.account);
  const pageId = meta?.pageId || (input.account.provider === "facebook" ? input.account.account_id : "");
  const igUserId =
    meta?.igUserId || (input.account.provider === "instagram" ? input.account.account_id : "");

  if (input.account.provider === "instagram" || (!pageId && igUserId)) {
    const imageUrl =
      input.imageUrl?.trim() || process.env.META_IG_FALLBACK_IMAGE_URL?.trim() || "";
    if (!imageUrl) {
      throw new Error(
        "Instagram requires a public image URL to publish. Add campaign media or set META_IG_FALLBACK_IMAGE_URL, or publish to Facebook Page instead."
      );
    }
    if (!igUserId) {
      throw new Error(
        "Instagram Professional account id missing. Disconnect Instagram and Connect again after linking IG to a Page."
      );
    }
    return pushToInstagram({
      igUserId,
      accessToken: token,
      caption: input.message,
      imageUrl,
    });
  }

  if (!pageId) {
    throw new Error(
      "Facebook Page id missing. Disconnect Facebook and Connect again, selecting your Page."
    );
  }

  return pushToFacebookPage({
    pageId,
    accessToken: token,
    message: input.message,
  });
}

export async function executePublish(input: {
  userId: string;
  businessId: string;
  campaignId: string;
  platform: PublishPlatform;
  previewToken: string;
  idempotencyKey: string;
  userEmail?: string | null;
  recipients?: string[];
}): Promise<{
  publish: {
    id: string;
    platform: PublishPlatform;
    status: string;
    accountName: string | null;
    externalId: string | null;
    publishedAt: string | null;
    reversible: boolean;
  };
  replayed?: boolean;
}> {
  verifyPreviewToken(input.previewToken, {
    userId: input.userId,
    businessId: input.businessId,
    campaignId: input.campaignId,
    platform: input.platform,
  });

  const preview = await buildPublishPreview({
    userId: input.userId,
    businessId: input.businessId,
    campaignId: input.campaignId,
    platform: input.platform,
    userEmail: input.userEmail,
  });

  if (!preview.authorized || !preview.previewToken) {
    throw new Error(
      input.platform === "meta"
        ? "Connect a Facebook or Instagram account before publishing."
        : input.platform === "email"
          ? "Email publishing needs ZeptoMail configured and an account email."
          : "Google Ads publishing requires demo mode or a connected Google Ads account."
    );
  }

  const emailRecipients =
    input.platform === "email"
      ? normalizeEmailRecipients(
          input.recipients?.length
            ? input.recipients
            : preview.accountName
              ? [preview.accountName]
              : []
        )
      : [];
  if (input.platform === "email" && emailRecipients.length === 0) {
    throw new Error("Add at least one valid recipient email before publishing.");
  }

  // Re-sign isn't needed — user must pass the token from the preview they confirmed.
  // Rebuilding preview above only refreshes authorization; the client's token is what we verified.

  const key = input.idempotencyKey.trim().slice(0, 128);

  const { data: existing } = await supabaseAdmin
    .from("campaign_publishes")
    .select("*")
    .eq("user_id", input.userId)
    .eq("campaign_id", input.campaignId)
    .eq("platform", input.platform)
    .eq("idempotency_key", key)
    .maybeSingle();

  if (existing) {
    const row = existing as {
      id: string;
      status: string;
      account_name: string | null;
      external_id: string | null;
      published_at: string | null;
      platform: PublishPlatform;
    };
    if (row.status === "published" || row.status === "revoked") {
      return {
        publish: {
          id: row.id,
          platform: row.platform,
          status: row.status,
          accountName: row.account_name,
          externalId: row.external_id,
          publishedAt: row.published_at,
          reversible:
            row.platform !== "email" && Boolean(row.external_id) && row.status === "published",
        },
        replayed: true,
      };
    }
    if (row.status === "publishing") {
      throw new Error("Publish already in progress for this request");
    }
    // failed — delete and retry below
    await supabaseAdmin.from("campaign_publishes").delete().eq("id", row.id);
  }

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("campaign_publishes")
    .insert({
      user_id: input.userId,
      business_id: input.businessId,
      campaign_id: input.campaignId,
      platform: input.platform,
      status: "publishing",
      account_provider: preview.accountProvider,
      account_name: preview.accountName,
      preview: {
        headlines: preview.headlines,
        primaryText: preview.primaryText,
        mode: preview.mode,
      },
      idempotency_key: key,
    })
    .select("*")
    .single();

  if (insertError || !inserted) {
    if (/duplicate|unique/i.test(insertError?.message || "")) {
      throw new Error("Publish already in progress for this request");
    }
    throw new Error(insertError?.message || "Failed to start publish");
  }

  const publishId = (inserted as { id: string }).id;

  try {
    let externalId: string;
    let mode: "live" | "demo" = preview.mode === "live" ? "live" : "demo";

    if (input.platform === "meta") {
      const account = await resolveMetaAccount(input.userId);
      if (account?.access_token && !isDemoMode()) {
        const campaignRow = await loadCampaign(input.userId, input.businessId, input.campaignId);
        const stats = campaignRow.stats || {};
        const imageUrl =
          typeof stats.imageUrl === "string"
            ? stats.imageUrl
            : typeof stats.image_url === "string"
              ? stats.image_url
              : null;
        const pushed = await pushMetaLive({
          account,
          message: [preview.campaignName, preview.primaryText, ...preview.headlines.slice(1)]
            .filter(Boolean)
            .join("\n\n"),
          imageUrl,
        });
        externalId = pushed.externalId;
        mode = pushed.mode;
      } else if (isDemoMode()) {
        externalId = `meta_demo_${crypto.randomUUID()}`;
        mode = "demo";
      } else {
        throw new Error("Connect a Facebook Page or Instagram Professional account before publishing.");
      }
    } else if (input.platform === "email") {
      const mail = buildMarketingEmailHtml({
        campaignName: preview.campaignName,
        headlines: preview.headlines,
        primaryText: preview.primaryText,
      });
      const failed: string[] = [];
      let sent = 0;
      for (const to of emailRecipients) {
        const result = await sendEmail({
          to,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        });
        if (result.ok) sent += 1;
        else failed.push(to);
      }
      if (sent === 0) {
        throw new Error(
          failed.length
            ? `Email send failed for ${failed.join(", ")}. Check ZeptoMail and try again.`
            : "Email send failed. Check ZeptoMail and try again."
        );
      }
      externalId = `email_zepto_${crypto.randomUUID()}`;
      mode = "live";
      preview.accountName =
        emailRecipients.length === 1
          ? emailRecipients[0]
          : `${sent} recipients${failed.length ? ` (${failed.length} failed)` : ""}`;
    } else {
      externalId = `google_ads_demo_${crypto.randomUUID()}`;
      mode = "demo";
    }

    const publishedAt = new Date().toISOString();
    const { data: updated, error: updateError } = await supabaseAdmin
      .from("campaign_publishes")
      .update({
        status: "published",
        external_id: externalId,
        published_at: publishedAt,
        updated_at: publishedAt,
        account_name: preview.accountName,
        preview: {
          headlines: preview.headlines,
          primaryText: preview.primaryText,
          mode,
          ...(input.platform === "email" ? { recipients: emailRecipients } : {}),
        },
      })
      .eq("id", publishId)
      .select("*")
      .single();

    if (updateError || !updated) {
      throw new Error(updateError?.message || "Failed to finalize publish");
    }

    await supabaseAdmin
      .from("campaigns")
      .update({ status: "active", updated_at: publishedAt })
      .eq("id", input.campaignId)
      .eq("user_id", input.userId)
      .eq("business_id", input.businessId);

    await logAccountAudit({
      userId: input.userId,
      businessId: input.businessId,
      action: "campaign.publish",
      actor: "user",
      reference: publishId,
      metadata: {
        campaignId: input.campaignId,
        platform: input.platform,
        externalId,
        mode,
        accountName: preview.accountName,
        ...(input.platform === "email" ? { recipients: emailRecipients } : {}),
      },
    });

    const row = updated as {
      id: string;
      platform: PublishPlatform;
      status: string;
      account_name: string | null;
      external_id: string | null;
      published_at: string | null;
    };

    return {
      publish: {
        id: row.id,
        platform: row.platform,
        status: row.status,
        accountName: row.account_name,
        externalId: row.external_id,
        publishedAt: row.published_at,
        reversible: input.platform === "email" ? false : Boolean(row.external_id),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Publish failed";
    await supabaseAdmin
      .from("campaign_publishes")
      .update({
        status: "failed",
        error_message: message.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("id", publishId);

    await logAccountAudit({
      userId: input.userId,
      businessId: input.businessId,
      action: "campaign.publish_failed",
      actor: "user",
      reference: publishId,
      metadata: {
        campaignId: input.campaignId,
        platform: input.platform,
        message,
      },
    });

    throw err;
  }
}

export async function revokePublish(input: {
  userId: string;
  businessId: string;
  campaignId: string;
  publishId: string;
}): Promise<{ id: string; status: string; revokedAt: string }> {
  const { data, error } = await supabaseAdmin
    .from("campaign_publishes")
    .select("*")
    .eq("id", input.publishId)
    .eq("user_id", input.userId)
    .eq("business_id", input.businessId)
    .eq("campaign_id", input.campaignId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Publish record not found");

  const row = data as {
    id: string;
    status: string;
    platform: PublishPlatform;
    external_id: string | null;
    account_provider: string | null;
  };

  if (row.status === "revoked") {
    return {
      id: row.id,
      status: "revoked",
      revokedAt: (data as { revoked_at?: string }).revoked_at || new Date().toISOString(),
    };
  }
  if (row.status !== "published") {
    throw new Error("Only published campaigns can be revoked");
  }

  if (row.platform === "meta" && row.external_id && !row.external_id.startsWith("meta_demo_") && !row.external_id.startsWith("meta_local_")) {
    const account = await resolveMetaAccount(input.userId);
    if (account?.access_token) {
      try {
        await fetch(
          `https://graph.facebook.com/v21.0/${encodeURIComponent(row.external_id)}?access_token=${encodeURIComponent(account.access_token)}`,
          { method: "DELETE" }
        );
      } catch (err) {
        console.warn("[campaign-publish] Meta revoke error:", err);
      }
    }
  }

  const revokedAt = new Date().toISOString();
  const { error: updateError } = await supabaseAdmin
    .from("campaign_publishes")
    .update({ status: "revoked", revoked_at: revokedAt, updated_at: revokedAt })
    .eq("id", row.id);

  if (updateError) throw new Error(updateError.message);

  await logAccountAudit({
    userId: input.userId,
    businessId: input.businessId,
    action: "campaign.publish_revoke",
    actor: "user",
    reference: row.id,
    metadata: {
      campaignId: input.campaignId,
      platform: row.platform,
      externalId: row.external_id,
    },
  });

  return { id: row.id, status: "revoked", revokedAt };
}

export async function listPublishes(input: {
  userId: string;
  businessId: string;
  campaignId: string;
}) {
  const { data, error } = await supabaseAdmin
    .from("campaign_publishes")
    .select(
      "id, platform, status, account_provider, account_name, external_id, published_at, revoked_at, created_at, error_message"
    )
    .eq("user_id", input.userId)
    .eq("business_id", input.businessId)
    .eq("campaign_id", input.campaignId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => {
    const r = row as {
      id: string;
      platform: PublishPlatform;
      status: string;
      account_provider: string | null;
      account_name: string | null;
      external_id: string | null;
      published_at: string | null;
      revoked_at: string | null;
      created_at: string;
      error_message: string | null;
    };
    return {
      id: r.id,
      platform: r.platform,
      status: r.status,
      accountProvider: r.account_provider,
      accountName: r.account_name,
      externalId: r.external_id,
      publishedAt: r.published_at,
      revokedAt: r.revoked_at,
      createdAt: r.created_at,
      errorMessage: r.error_message,
      reversible:
        r.platform !== "email" && r.status === "published" && Boolean(r.external_id),
    };
  });
}

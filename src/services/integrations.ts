import * as crypto from "node:crypto";
import { supabaseAdmin } from "../config/supabase";
import { appUrl } from "./mailer";

export type IntegrationProvider = "instagram" | "facebook" | "tiktok" | "linkedin";

export type IntegrationView = {
  provider: IntegrationProvider;
  connected: boolean;
  accountName: string;
  connectedAt: string | null;
  configured: boolean;
};

type IntegrationRow = {
  provider: IntegrationProvider;
  status: string;
  account_name: string;
  connected_at: string;
};

const PROVIDERS: IntegrationProvider[] = ["instagram", "facebook", "tiktok", "linkedin"];

function backendPublicUrl() {
  return (process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 4210}`).replace(/\/$/, "");
}

function oauthStateSecret() {
  return (
    process.env.INTEGRATIONS_STATE_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "convertide-integrations-dev"
  );
}

export function signOAuthState(payload: { userId: string; provider: IntegrationProvider }) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + 10 * 60 * 1000 }),
    "utf8"
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", oauthStateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyOAuthState(state: string): { userId: string; provider: IntegrationProvider } {
  const [body, sig] = state.split(".");
  if (!body || !sig) throw new Error("Invalid OAuth state");
  const expected = crypto.createHmac("sha256", oauthStateSecret()).update(body).digest("base64url");
  if (sig.length !== expected.length) {
    throw new Error("Invalid OAuth state signature");
  }
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error("Invalid OAuth state signature");
  }
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
    userId?: string;
    provider?: IntegrationProvider;
    exp?: number;
  };
  if (!parsed.userId || !parsed.provider || !PROVIDERS.includes(parsed.provider)) {
    throw new Error("Invalid OAuth state payload");
  }
  if (!parsed.exp || parsed.exp < Date.now()) {
    throw new Error("OAuth state expired — try connecting again");
  }
  return { userId: parsed.userId, provider: parsed.provider };
}

export function isProviderConfigured(provider: IntegrationProvider): boolean {
  if (process.env.INTEGRATIONS_DEMO_MODE === "true" || process.env.INTEGRATIONS_DEMO_MODE === "1") {
    return true;
  }

  switch (provider) {
    case "facebook":
    case "instagram":
      return Boolean(process.env.META_APP_ID?.trim() && process.env.META_APP_SECRET?.trim());
    case "linkedin":
      return Boolean(process.env.LINKEDIN_CLIENT_ID?.trim() && process.env.LINKEDIN_CLIENT_SECRET?.trim());
    case "tiktok":
      return Boolean(process.env.TIKTOK_CLIENT_KEY?.trim() && process.env.TIKTOK_CLIENT_SECRET?.trim());
    default:
      return false;
  }
}

export function isDemoMode() {
  return process.env.INTEGRATIONS_DEMO_MODE === "true" || process.env.INTEGRATIONS_DEMO_MODE === "1";
}

export async function listIntegrations(userId: string): Promise<IntegrationView[]> {
  const { data, error } = await supabaseAdmin
    .from("user_integrations")
    .select("provider, status, account_name, connected_at")
    .eq("user_id", userId)
    .eq("status", "connected");

  if (error) {
    if (/relation|does not exist/i.test(error.message)) {
      return PROVIDERS.map((provider) => ({
        provider,
        connected: false,
        accountName: "",
        connectedAt: null,
        configured: isProviderConfigured(provider),
      }));
    }
    throw new Error(error.message);
  }

  const byProvider = new Map(
    ((data ?? []) as IntegrationRow[]).map((row) => [row.provider, row])
  );

  return PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    return {
      provider,
      connected: Boolean(row),
      accountName: row?.account_name ?? "",
      connectedAt: row?.connected_at ?? null,
      configured: isProviderConfigured(provider),
    };
  });
}

export async function disconnectIntegration(userId: string, provider: IntegrationProvider) {
  const { error } = await supabaseAdmin
    .from("user_integrations")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);

  if (error) throw new Error(error.message);
}

export async function upsertConnectedIntegration(input: {
  userId: string;
  provider: IntegrationProvider;
  accountName: string;
  accountId?: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}) {
  const { error } = await supabaseAdmin.from("user_integrations").upsert(
    {
      user_id: input.userId,
      provider: input.provider,
      status: "connected",
      account_name: input.accountName,
      account_id: input.accountId ?? "",
      access_token: input.accessToken ?? null,
      refresh_token: input.refreshToken ?? null,
      token_expires_at: input.tokenExpiresAt ?? null,
      scopes: input.scopes ?? [],
      metadata: input.metadata ?? {},
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" }
  );

  if (error) throw new Error(error.message);
}

function callbackUrl(provider: IntegrationProvider) {
  return `${backendPublicUrl()}/api/integrations/callback/${provider}`;
}

export function buildAuthorizeUrl(userId: string, provider: IntegrationProvider): string {
  if (!isProviderConfigured(provider)) {
    throw new Error(`${provider} is not configured. Add provider credentials to the backend .env.`);
  }

  if (isDemoMode() && !hasRealCredentials(provider)) {
    // Demo mode without real OAuth credentials — frontend should use POST /connect instead.
    throw new Error("DEMO_CONNECT");
  }

  const state = signOAuthState({ userId, provider });

  if (provider === "facebook" || provider === "instagram") {
    const appId = process.env.META_APP_ID!.trim();
    // Newer Meta apps (Unified Login / Facebook Login for Business) require a configuration ID
    // instead of (or preferred over) raw scope lists. Create configs in App Dashboard → Use cases.
    const configId =
      provider === "instagram"
        ? process.env.META_INSTAGRAM_CONFIG_ID?.trim() || process.env.META_FACEBOOK_CONFIG_ID?.trim()
        : process.env.META_FACEBOOK_CONFIG_ID?.trim() || process.env.META_INSTAGRAM_CONFIG_ID?.trim();

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: callbackUrl(provider),
      state,
      response_type: "code",
    });

    if (configId) {
      params.set("config_id", configId);
    } else {
      // Fallback for older apps that still authorize via scopes.
      const scopes =
        provider === "instagram"
          ? "pages_show_list,pages_read_engagement,pages_manage_metadata,instagram_basic,instagram_content_publish,business_management"
          : "pages_show_list,pages_read_engagement,pages_manage_metadata,pages_manage_posts,business_management";
      params.set("scope", scopes);
    }

    return `https://www.facebook.com/v21.0/dialog/oauth?${params}`;
  }

  if (provider === "linkedin") {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: process.env.LINKEDIN_CLIENT_ID!.trim(),
      redirect_uri: callbackUrl(provider),
      state,
      scope: "openid profile w_member_social",
    });
    return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
  }

  // tiktok
  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY!.trim(),
    redirect_uri: callbackUrl("tiktok"),
    response_type: "code",
    scope: "user.info.basic,video.publish,video.upload",
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params}`;
}

function hasRealCredentials(provider: IntegrationProvider) {
  switch (provider) {
    case "facebook":
    case "instagram":
      return Boolean(process.env.META_APP_ID?.trim() && process.env.META_APP_SECRET?.trim());
    case "linkedin":
      return Boolean(process.env.LINKEDIN_CLIENT_ID?.trim() && process.env.LINKEDIN_CLIENT_SECRET?.trim());
    case "tiktok":
      return Boolean(process.env.TIKTOK_CLIENT_KEY?.trim() && process.env.TIKTOK_CLIENT_SECRET?.trim());
    default:
      return false;
  }
}

export async function connectDemo(userId: string, provider: IntegrationProvider) {
  if (!isDemoMode()) {
    throw new Error("Demo connect is disabled. Set INTEGRATIONS_DEMO_MODE=true or configure OAuth.");
  }
  const labels: Record<IntegrationProvider, string> = {
    instagram: "Instagram (demo)",
    facebook: "Facebook (demo)",
    tiktok: "TikTok (demo)",
    linkedin: "LinkedIn (demo)",
  };
  await upsertConnectedIntegration({
    userId,
    provider,
    accountName: labels[provider],
    metadata: { mode: "demo" },
  });
}

export async function handleOAuthCallback(provider: IntegrationProvider, code: string, state: string) {
  const { userId } = verifyOAuthState(state);

  if (provider === "facebook" || provider === "instagram") {
    await exchangeMetaCode(userId, provider, code);
  } else if (provider === "linkedin") {
    await exchangeLinkedInCode(userId, code);
  } else if (provider === "tiktok") {
    await exchangeTikTokCode(userId, code);
  }

  return { userId, provider };
}

type MetaPageAccount = {
  id?: string;
  name?: string;
  access_token?: string;
  tasks?: string[];
  instagram_business_account?: { id?: string; username?: string };
};

/** Page + optional IG Pro ids stored on facebook/instagram integrations for live publish. */
export type MetaPublishMetadata = {
  platform: "meta";
  userId?: string;
  pageId: string;
  pageName: string;
  igUserId?: string;
  igUsername?: string;
};

const META_GRAPH = "https://graph.facebook.com/v21.0";

async function exchangeMetaCode(userId: string, provider: IntegrationProvider, code: string) {
  const appId = process.env.META_APP_ID!.trim();
  const appSecret = process.env.META_APP_SECRET!.trim();

  const tokenUrl = new URL(`${META_GRAPH}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", appId);
  tokenUrl.searchParams.set("client_secret", appSecret);
  tokenUrl.searchParams.set("redirect_uri", callbackUrl(provider));
  tokenUrl.searchParams.set("code", code);

  const tokenRes = await fetch(tokenUrl);
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: { message?: string };
  };
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(tokenJson.error?.message || "Meta token exchange failed");
  }

  // Long-lived user token (~60 days). Page tokens derived from it stay long-lived.
  let userToken = tokenJson.access_token;
  let expiresIn = tokenJson.expires_in;
  try {
    const llUrl = new URL(`${META_GRAPH}/oauth/access_token`);
    llUrl.searchParams.set("grant_type", "fb_exchange_token");
    llUrl.searchParams.set("client_id", appId);
    llUrl.searchParams.set("client_secret", appSecret);
    llUrl.searchParams.set("fb_exchange_token", tokenJson.access_token);
    const llRes = await fetch(llUrl);
    const llJson = (await llRes.json()) as { access_token?: string; expires_in?: number };
    if (llRes.ok && llJson.access_token) {
      userToken = llJson.access_token;
      expiresIn = llJson.expires_in ?? expiresIn;
    }
  } catch {
    // Keep short-lived token if exchange fails.
  }

  const meRes = await fetch(
    `${META_GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(userToken)}`
  );
  const me = (await meRes.json()) as { id?: string; name?: string };

  const pagesRes = await fetch(
    `${META_GRAPH}/me/accounts?fields=id,name,access_token,tasks,instagram_business_account{id,username}&access_token=${encodeURIComponent(userToken)}`
  );
  const pagesJson = (await pagesRes.json()) as {
    data?: MetaPageAccount[];
    error?: { message?: string };
  };
  if (!pagesRes.ok) {
    throw new Error(
      pagesJson.error?.message ||
        "Could not list Facebook Pages. Grant Page access during Connect and try again."
    );
  }

  const pages = pagesJson.data ?? [];
  const withContent = pages.filter((p) =>
    Array.isArray(p.tasks) ? p.tasks.includes("CREATE_CONTENT") || p.tasks.length === 0 : true
  );
  const ranked = (withContent.length ? withContent : pages).filter((p) => p.id && p.access_token);

  if (provider === "facebook") {
    const page = ranked[0];
    if (!page?.id || !page.access_token) {
      throw new Error(
        "No Facebook Page was shared. Create or select a Page during Connect, then try again."
      );
    }
    const ig = page.instagram_business_account;
    const metadata: MetaPublishMetadata = {
      platform: "meta",
      userId: me.id,
      pageId: page.id,
      pageName: page.name || "Facebook Page",
      ...(ig?.id
        ? { igUserId: ig.id, igUsername: ig.username || undefined }
        : {}),
    };
    await upsertConnectedIntegration({
      userId,
      provider: "facebook",
      accountName: page.name || "Facebook Page",
      accountId: page.id,
      accessToken: page.access_token,
      tokenExpiresAt: expiresIn
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null,
      scopes: ["pages_manage_posts", "pages_show_list"],
      metadata,
    });
    return;
  }

  // Instagram: need a Professional account linked to a Page the user granted.
  const withIg = ranked.find((p) => p.instagram_business_account?.id);
  if (!withIg?.id || !withIg.access_token || !withIg.instagram_business_account?.id) {
    throw new Error(
      "No Instagram Professional account was shared. Switch Instagram to Business or Creator, link it to a Facebook Page, then Connect again. Personal Instagram cannot be used."
    );
  }
  const ig = withIg.instagram_business_account;
  const metadata: MetaPublishMetadata = {
    platform: "meta",
    userId: me.id,
    pageId: withIg.id,
    pageName: withIg.name || "Facebook Page",
    igUserId: ig.id!,
    igUsername: ig.username || undefined,
  };
  await upsertConnectedIntegration({
    userId,
    provider: "instagram",
    accountName: ig.username ? `@${ig.username}` : "Instagram Professional",
    accountId: ig.id!,
    accessToken: withIg.access_token,
    tokenExpiresAt: expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null,
    scopes: ["instagram_basic", "instagram_content_publish"],
    metadata,
  });
}

async function exchangeLinkedInCode(userId: string, code: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl("linkedin"),
    client_id: process.env.LINKEDIN_CLIENT_ID!.trim(),
    client_secret: process.env.LINKEDIN_CLIENT_SECRET!.trim(),
  });

  const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(tokenJson.error_description || "LinkedIn token exchange failed");
  }

  const meRes = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  const me = (await meRes.json()) as { sub?: string; name?: string; email?: string };

  await upsertConnectedIntegration({
    userId,
    provider: "linkedin",
    accountName: me.name || me.email || "LinkedIn account",
    accountId: me.sub || "",
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token || null,
    tokenExpiresAt: tokenJson.expires_in
      ? new Date(Date.now() + tokenJson.expires_in * 1000).toISOString()
      : null,
  });
}

async function exchangeTikTokCode(userId: string, code: string) {
  const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY!.trim(),
      client_secret: process.env.TIKTOK_CLIENT_SECRET!.trim(),
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl("tiktok"),
    }),
  });
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    open_id?: string;
    error_description?: string;
    error?: string;
  };
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(tokenJson.error_description || tokenJson.error || "TikTok token exchange failed");
  }

  await upsertConnectedIntegration({
    userId,
    provider: "tiktok",
    accountName: "TikTok account",
    accountId: tokenJson.open_id || "",
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token || null,
    tokenExpiresAt: tokenJson.expires_in
      ? new Date(Date.now() + tokenJson.expires_in * 1000).toISOString()
      : null,
  });
}

export function frontendIntegrationsRedirect(query: Record<string, string>) {
  const params = new URLSearchParams({ tab: "integrations", ...query });
  return appUrl(`/dashboard/settings?${params}`);
}

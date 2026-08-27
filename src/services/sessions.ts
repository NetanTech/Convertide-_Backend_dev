import type { Request } from "express";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../config/supabase";

export type SessionDeviceKind = "desktop" | "mobile" | "tablet" | "unknown";

export type AuthSessionView = {
  id: string;
  device: string;
  subtitle: string;
  current: boolean;
  kind: SessionDeviceKind;
  createdAt: string;
  lastActiveAt: string;
  ip: string;
};

type AuthSessionRow = {
  id: string;
  created_at: string;
  updated_at: string | null;
  refreshed_at: string | null;
  user_agent: string | null;
  ip: string | null;
  aal: string | null;
};

type DeviceMetaRow = {
  session_id: string;
  user_agent: string;
  ip: string;
  created_at: string;
  last_seen_at: string;
};

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = Buffer.from(part, "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function sessionIdFromAccessToken(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const id = payload?.session_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]!.trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(",")[0]!.trim();
  }
  return req.socket.remoteAddress || "";
}

export function clientUserAgent(req: Request): string {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua : "";
}

/** Anon client that forwards the browser UA/IP so GoTrue can store them on the session. */
export function supabaseAuthForRequest(req: Request) {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  }

  const ua = clientUserAgent(req) || "Convertide";
  const ip = clientIp(req);

  return createClient(url, anon, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        "User-Agent": ua,
        ...(ip ? { "X-Forwarded-For": ip } : {}),
      },
    },
  });
}

function detectKind(ua: string): SessionDeviceKind {
  const value = ua.toLowerCase();
  if (!value) return "unknown";
  if (/ipad|tablet|kindle|silk|(android(?!.*mobile))/.test(value)) return "tablet";
  if (/mobi|iphone|ipod|android.*mobile|windows phone|opera mini/.test(value)) return "mobile";
  if (/windows|macintosh|linux|cros|x11/.test(value)) return "desktop";
  return "unknown";
}

function browserLabel(ua: string): string {
  if (/edg\//i.test(ua)) return "Edge";
  if (/chrome\//i.test(ua) && !/edg\//i.test(ua)) return "Chrome";
  if (/safari\//i.test(ua) && !/chrome\//i.test(ua)) return "Safari";
  if (/firefox\//i.test(ua)) return "Firefox";
  if (/opera|opr\//i.test(ua)) return "Opera";
  return "Browser";
}

function osLabel(ua: string): string {
  if (/windows nt/i.test(ua)) return "Windows";
  if (/mac os x|macintosh/i.test(ua)) return "macOS";
  if (/android/i.test(ua)) return "Android";
  if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
  if (/cros/i.test(ua)) return "Chrome OS";
  if (/linux/i.test(ua)) return "Linux";
  return "Unknown OS";
}

function deviceTitle(ua: string, kind: SessionDeviceKind): string {
  const os = osLabel(ua);
  if (kind === "mobile") {
    if (/iphone/i.test(ua)) return "iPhone";
    if (/android/i.test(ua)) return "Android phone";
    return `${os} phone`;
  }
  if (kind === "tablet") {
    if (/ipad/i.test(ua)) return "iPad";
    return `${os} tablet`;
  }
  if (kind === "desktop") {
    if (/macintosh/i.test(ua)) return "Mac";
    if (/windows/i.test(ua)) return "Windows PC";
    return `${os} computer`;
  }
  return "Unknown device";
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown time";

  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function normalizeIp(ip: string): string {
  // Postgres inet often renders as "1.2.3.4/32"
  return ip.replace(/\/\d+$/, "").trim();
}

function pickUserAgent(...candidates: Array<string | null | undefined>): string {
  for (const value of candidates) {
    const trimmed = (value || "").trim();
    if (!trimmed) continue;
    // Ignore server-side clients that aren't real browsers
    if (/^(node|undici|axios|got|curl|python|postman|convertide)\b/i.test(trimmed)) continue;
    return trimmed;
  }
  return "";
}

function pickIp(...candidates: Array<string | null | undefined>): string {
  for (const value of candidates) {
    const trimmed = normalizeIp(value || "");
    if (trimmed) return trimmed;
  }
  return "";
}

function toView(
  row: AuthSessionRow,
  meta: DeviceMetaRow | undefined,
  currentSessionId: string | null,
  currentRequestUa = "",
  currentRequestIp = ""
): AuthSessionView {
  const current = Boolean(currentSessionId && row.id === currentSessionId);
  const ua = pickUserAgent(
    meta?.user_agent,
    current ? currentRequestUa : "",
    row.user_agent
  );
  const ip = pickIp(meta?.ip, current ? currentRequestIp : "", row.ip);
  const kind = detectKind(ua);
  const lastActiveAt = meta?.last_seen_at || row.refreshed_at || row.updated_at || row.created_at;
  const createdAt = meta?.created_at || row.created_at;

  const parts = [
    browserLabel(ua),
    osLabel(ua),
    ip || null,
    current ? "Now (current)" : formatWhen(lastActiveAt),
  ].filter(Boolean);

  return {
    id: row.id,
    device: deviceTitle(ua, kind),
    subtitle: parts.join(" · "),
    current,
    kind,
    createdAt,
    lastActiveAt,
    ip,
  };
}

export async function rememberSessionDevice(
  userId: string,
  accessToken: string,
  req: Request
): Promise<void> {
  const sessionId = sessionIdFromAccessToken(accessToken);
  if (!sessionId) return;

  const ua = clientUserAgent(req).trim();
  const ip = normalizeIp(clientIp(req));
  if (!ua && !ip) return;

  const now = new Date().toISOString();

  const { error } = await supabaseAdmin.from("user_session_devices").upsert(
    {
      session_id: sessionId,
      user_id: userId,
      user_agent: ua,
      ip,
      last_seen_at: now,
    },
    { onConflict: "session_id" }
  );

  if (error) {
    // Table may not exist until migration 009 is applied — don't fail auth.
    console.warn("[sessions] remember device failed:", error.message);
  }
}

export async function listUserSessions(
  userId: string,
  accessToken: string,
  req?: Request
): Promise<AuthSessionView[]> {
  const currentSessionId = sessionIdFromAccessToken(accessToken);
  const currentRequestUa = req ? clientUserAgent(req) : "";
  const currentRequestIp = req ? normalizeIp(clientIp(req)) : "";

  const { data: rows, error } = await supabaseAdmin.rpc("list_auth_sessions", {
    p_user_id: userId,
  });

  if (error) {
    throw new Error(
      error.message.includes("Could not find the function")
        ? "Session listing is not set up yet. Run migrations/009_auth_sessions.sql in Supabase."
        : error.message
    );
  }

  const sessions = (rows ?? []) as AuthSessionRow[];
  const ids = sessions.map((s) => s.id);

  let metaById = new Map<string, DeviceMetaRow>();
  if (ids.length > 0) {
    const { data: metaRows } = await supabaseAdmin
      .from("user_session_devices")
      .select("session_id, user_agent, ip, created_at, last_seen_at")
      .eq("user_id", userId)
      .in("session_id", ids);

    metaById = new Map(
      ((metaRows ?? []) as DeviceMetaRow[]).map((row) => [row.session_id, row])
    );
  }

  return sessions.map((row) =>
    toView(row, metaById.get(row.id), currentSessionId, currentRequestUa, currentRequestIp)
  );
}

export async function revokeUserSession(
  userId: string,
  sessionId: string,
  accessToken: string
): Promise<void> {
  const currentSessionId = sessionIdFromAccessToken(accessToken);
  if (currentSessionId && currentSessionId === sessionId) {
    throw new Error("You can't revoke the session you're using. Sign out instead.");
  }

  const { data, error } = await supabaseAdmin.rpc("revoke_auth_session", {
    p_user_id: userId,
    p_session_id: sessionId,
  });

  if (error) {
    throw new Error(
      error.message.includes("Could not find the function")
        ? "Session revoke is not set up yet. Run migrations/009_auth_sessions.sql in Supabase."
        : error.message
    );
  }

  if (data !== true) {
    throw new Error("Session not found");
  }
}

export async function cleanupDeviceMetaExcept(userId: string, keepSessionId: string | null) {
  let query = supabaseAdmin.from("user_session_devices").delete().eq("user_id", userId);
  if (keepSessionId) {
    query = query.neq("session_id", keepSessionId);
  }
  const { error } = await query;
  if (error) {
    console.warn("[sessions] cleanup device meta failed:", error.message);
  }
}

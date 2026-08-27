import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type MfaStatus = {
  enabled: boolean;
  factorId: string | null;
  friendlyName: string | null;
};

export type MfaEnrollResult = {
  factorId: string;
  qrCode: string;
  secret: string;
  uri: string;
};

function supabaseAsUser(accessToken: string): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  }

  return createClient(url, anon, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

async function supabaseWithSession(accessToken: string, refreshToken: string): Promise<SupabaseClient> {
  const client = supabaseAsUser(accessToken);
  const { error } = await client.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error) {
    throw new Error(error.message || "Could not restore session for MFA");
  }
  return client;
}

export async function getMfaStatus(accessToken: string): Promise<MfaStatus> {
  const client = supabaseAsUser(accessToken);
  const { data, error } = await client.auth.mfa.listFactors();
  if (error) throw new Error(error.message);

  const verified = data.totp.find((f) => f.status === "verified") ?? null;
  return {
    enabled: Boolean(verified),
    factorId: verified?.id ?? null,
    friendlyName: verified?.friendly_name ?? null,
  };
}

export async function enrollTotp(
  accessToken: string,
  refreshToken: string
): Promise<MfaEnrollResult> {
  const client = await supabaseWithSession(accessToken, refreshToken);

  // Drop unfinished enrollments so we don't hit factor limits.
  const listed = await client.auth.mfa.listFactors();
  if (!listed.error) {
    for (const factor of listed.data.all) {
      if (factor.factor_type === "totp" && factor.status === "unverified") {
        await client.auth.mfa.unenroll({ factorId: factor.id });
      }
    }
  }

  const { data, error } = await client.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "Authenticator App",
  });

  if (error || !data) {
    throw new Error(error?.message || "Could not start authenticator setup");
  }

  return {
    factorId: data.id,
    qrCode: data.totp.qr_code,
    secret: data.totp.secret,
    uri: data.totp.uri,
  };
}

export async function verifyTotpEnrollment(
  accessToken: string,
  refreshToken: string,
  input: { factorId: string; code: string }
): Promise<{ access_token: string; refresh_token: string; expires_at?: number }> {
  const client = await supabaseWithSession(accessToken, refreshToken);
  const code = input.code.replace(/\s+/g, "");

  const { data, error } = await client.auth.mfa.challengeAndVerify({
    factorId: input.factorId,
    code,
  });

  if (error || !data?.access_token || !data?.refresh_token) {
    throw new Error(error?.message || "Invalid authenticator code");
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_in
      ? Math.floor(Date.now() / 1000) + data.expires_in
      : undefined,
  };
}

export async function cancelTotpEnrollment(
  accessToken: string,
  refreshToken: string,
  factorId: string
): Promise<void> {
  const client = await supabaseWithSession(accessToken, refreshToken);
  const { error } = await client.auth.mfa.unenroll({ factorId });
  if (error) throw new Error(error.message);
}

export async function disableTotp(
  accessToken: string,
  refreshToken: string,
  input: { factorId: string; code: string }
): Promise<void> {
  const client = await supabaseWithSession(accessToken, refreshToken);
  const code = input.code.replace(/\s+/g, "");

  // Confirm possession of the authenticator before removing it.
  const { error: verifyError } = await client.auth.mfa.challengeAndVerify({
    factorId: input.factorId,
    code,
  });
  if (verifyError) {
    throw new Error(verifyError.message || "Invalid authenticator code");
  }

  const { error } = await client.auth.mfa.unenroll({ factorId: input.factorId });
  if (error) throw new Error(error.message);
}

export type LoginMfaCheck = {
  mfaRequired: boolean;
  factorId: string | null;
};

export async function checkLoginNeedsMfa(
  accessToken: string,
  refreshToken: string
): Promise<LoginMfaCheck> {
  const client = await supabaseWithSession(accessToken, refreshToken);
  const { data: aal, error: aalError } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalError) {
    // If MFA APIs fail, don't block login.
    console.warn("[mfa] AAL check failed:", aalError.message);
    return { mfaRequired: false, factorId: null };
  }

  if (aal.nextLevel === "aal2" && aal.currentLevel !== "aal2") {
    const { data: factors } = await client.auth.mfa.listFactors();
    const verified = factors?.totp.find((f) => f.status === "verified") ?? null;
    return { mfaRequired: true, factorId: verified?.id ?? null };
  }

  return { mfaRequired: false, factorId: null };
}

export async function verifyLoginTotp(
  accessToken: string,
  refreshToken: string,
  input: { factorId: string; code: string }
): Promise<{ access_token: string; refresh_token: string; expires_at?: number }> {
  const client = await supabaseWithSession(accessToken, refreshToken);
  const code = input.code.replace(/\s+/g, "");

  const { data, error } = await client.auth.mfa.challengeAndVerify({
    factorId: input.factorId,
    code,
  });

  if (error || !data?.access_token || !data?.refresh_token) {
    throw new Error(error?.message || "Invalid authenticator code");
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_in
      ? Math.floor(Date.now() / 1000) + data.expires_in
      : undefined,
  };
}

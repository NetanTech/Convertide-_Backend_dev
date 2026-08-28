import { Router } from "express";
import multer from "multer";
import { supabase, supabaseAdmin } from "../config/supabase";
import { asyncHandler } from "../middleware/errorHandler";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { getOnboardingCompleted, uploadAvatar, deleteAvatar, deleteUserAccount } from "../services/profile";
import {
  cleanupDeviceMetaExcept,
  listUserSessions,
  rememberSessionDevice,
  revokeUserSession,
  sessionIdFromAccessToken,
  supabaseAuthForRequest,
} from "../services/sessions";
import {
  cancelTotpEnrollment,
  checkLoginNeedsMfa,
  disableTotp,
  enrollTotp,
  getMfaStatus,
  verifyLoginTotp,
  verifyTotpEnrollment,
} from "../services/mfa";

const router = Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB, matches the frontend's stated limit
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      cb(new Error("Only JPG, PNG, GIF, or WEBP images are allowed"));
      return;
    }
    cb(null, true);
  },
});

function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function emailHasAccount(email: string): Promise<boolean | null> {
  const normalized = email.trim().toLowerCase();
  try {
    let page = 1;
    while (page <= 50) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
      if (error || !data?.users) return null;
      if (data.users.some((user) => user.email?.toLowerCase() === normalized)) return true;
      if (data.users.length < 200) return false;
      page += 1;
    }
    return null;
  } catch {
    return null;
  }
}

function isValidPassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= 8;
}

function readRefreshToken(req: { body?: unknown }): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const value = body.refreshToken ?? body.refresh_token;
  return typeof value === "string" ? value : "";
}

function readMfaCode(req: { body?: unknown }): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const value = body.code;
  return typeof value === "string" ? value.trim() : "";
}

async function sessionResponse(
  session: { access_token: string; refresh_token: string; expires_at?: number } | null,
  user: { id: string } | null | undefined
) {
  const onboardingCompleted = user?.id ? await getOnboardingCompleted(user.id) : false;

  return {
    user,
    onboardingCompleted,
    tokens: session
      ? {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_at: session.expires_at,
        }
      : null,
  };
}

// POST /api/auth/register
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body ?? {};

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "A valid email is required" });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
    }

    const { data, error } = await supabase.auth.signUp({ email, password });

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    // Supabase returns a fake "success" with an empty identities array when the
    // email is already registered and confirmed, to avoid leaking which emails
    // exist. Detect that here so the client isn't told a code was sent when it wasn't.
    const isExistingConfirmedUser = (data.user?.identities?.length ?? 0) === 0;

    if (isExistingConfirmedUser) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists. Try logging in instead.",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Account created. Check your email for a verification code.",
      data: { email, userId: data.user?.id },
    });
  })
);

// POST /api/auth/verify-email
router.post(
  "/verify-email",
  asyncHandler(async (req, res) => {
    const { email, token } = req.body ?? {};

    if (!isValidEmail(email) || typeof token !== "string" || token.length === 0) {
      return res.status(400).json({ success: false, message: "Email and verification code are required" });
    }

    const { data, error } = await supabaseAuthForRequest(req).auth.verifyOtp({
      email,
      token,
      type: "signup",
    });

    if (error || !data.session) {
      return res.status(400).json({ success: false, message: error?.message || "Invalid or expired code" });
    }

    if (data.user?.id) {
      await rememberSessionDevice(data.user.id, data.session.access_token, req);
    }

    return res.json({
      success: true,
      message: "Email verified",
      data: await sessionResponse(data.session, data.user),
    });
  })
);

// POST /api/auth/resend-verification
router.post(
  "/resend-verification",
  asyncHandler(async (req, res) => {
    const { email } = req.body ?? {};

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "A valid email is required" });
    }

    const { error } = await supabase.auth.resend({ type: "signup", email });

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.json({ success: true, message: "Verification code resent" });
  })
);

// POST /api/auth/login
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body ?? {};

    if (!isValidEmail(email) || typeof password !== "string" || password.length === 0) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const { data, error } = await supabaseAuthForRequest(req).auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.session) {
      const exists = await emailHasAccount(email);
      return res.status(401).json({
        success: false,
        message:
          exists === false
            ? "That email doesn't have an account"
            : "Invalid email or password",
      });
    }

    if (data.user?.id) {
      await rememberSessionDevice(data.user.id, data.session.access_token, req);
    }

    const mfa = await checkLoginNeedsMfa(data.session.access_token, data.session.refresh_token);
    const base = await sessionResponse(data.session, data.user);

    return res.json({
      success: true,
      message: mfa.mfaRequired ? "Authenticator code required" : "Logged in",
      data: {
        ...base,
        mfaRequired: mfa.mfaRequired,
        factorId: mfa.factorId,
      },
    });
  })
);

// POST /api/auth/oauth/session — finalize Google (or other) OAuth after frontend has tokens
router.post(
  "/oauth/session",
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const accessToken =
      typeof body.access_token === "string"
        ? body.access_token
        : typeof body.accessToken === "string"
          ? body.accessToken
          : "";
    const refreshToken =
      typeof body.refresh_token === "string"
        ? body.refresh_token
        : typeof body.refreshToken === "string"
          ? body.refreshToken
          : "";

    if (!accessToken || !refreshToken) {
      return res.status(400).json({
        success: false,
        message: "access_token and refresh_token are required",
      });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
    if (userError || !userData.user) {
      return res.status(401).json({ success: false, message: "Invalid or expired OAuth session" });
    }

    await rememberSessionDevice(userData.user.id, accessToken, req);

    const mfa = await checkLoginNeedsMfa(accessToken, refreshToken);
    const base = await sessionResponse(
      { access_token: accessToken, refresh_token: refreshToken },
      userData.user
    );

    return res.json({
      success: true,
      message: mfa.mfaRequired ? "Authenticator code required" : "Logged in",
      data: {
        ...base,
        mfaRequired: mfa.mfaRequired,
        factorId: mfa.factorId,
      },
    });
  })
);

// POST /api/auth/refresh
router.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const { refresh_token: refreshToken } = req.body ?? {};

    if (typeof refreshToken !== "string" || refreshToken.length === 0) {
      return res.status(400).json({ success: false, message: "refresh_token is required" });
    }

    const { data, error } = await supabaseAuthForRequest(req).auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.session) {
      return res.status(401).json({ success: false, message: "Invalid or expired refresh token" });
    }

    if (data.user?.id) {
      await rememberSessionDevice(data.user.id, data.session.access_token, req);
    }

    return res.json({
      success: true,
      data: await sessionResponse(data.session, data.user),
    });
  })
);

// POST /api/auth/logout (requires Authorization: Bearer <access_token>)
router.post(
  "/logout",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    if (req.accessToken) {
      // "local" — revokes only this session's refresh token, leaving the
      // user's other devices logged in. (Previously this passed "global",
      // which silently logged the user out everywhere on every click.)
      await supabaseAdmin.auth.admin.signOut(req.accessToken, "local");
    }
    return res.json({ success: true, message: "Logged out" });
  })
);

// POST /api/auth/logout-all-devices (requires Authorization: Bearer <access_token>)
router.post(
  "/logout-all-devices",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.accessToken) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    // "others" — revokes every session except the one making this request,
    // so the current device stays logged in while everything else is kicked out.
    const { error } = await supabaseAdmin.auth.admin.signOut(req.accessToken, "others");
    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    const keepId = sessionIdFromAccessToken(req.accessToken);
    if (req.user?.id) {
      await cleanupDeviceMetaExcept(req.user.id, keepId);
    }

    return res.json({ success: true, message: "Logged out of all other devices" });
  })
);

// GET /api/auth/sessions — list active devices/sessions for the signed-in user
router.get(
  "/sessions",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id;
    const accessToken = req.accessToken;
    if (!userId || !accessToken) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    try {
      // Capture this browser's UA/IP for the current session (older logins had empty UA).
      await rememberSessionDevice(userId, accessToken, req);
      const sessions = await listUserSessions(userId, accessToken, req);
      return res.json({ success: true, data: { sessions } });
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : "Could not load sessions",
      });
    }
  })
);

// DELETE /api/auth/sessions/:id — revoke one other session
router.delete(
  "/sessions/:id",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id;
    const accessToken = req.accessToken;
    const sessionId = typeof req.params.id === "string" ? req.params.id : "";

    if (!userId || !accessToken) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    if (!sessionId) {
      return res.status(400).json({ success: false, message: "Session id is required" });
    }

    try {
      await revokeUserSession(userId, sessionId, accessToken);
      return res.json({ success: true, message: "Session revoked" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not revoke session";
      const status = message.includes("can't revoke") ? 400 : message.includes("not found") ? 404 : 500;
      return res.status(status).json({ success: false, message });
    }
  })
);

// GET /api/auth/mfa/status
router.get(
  "/mfa/status",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.accessToken) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    try {
      const status = await getMfaStatus(req.accessToken);
      return res.json({ success: true, data: status });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : "Could not load MFA status",
      });
    }
  })
);

// POST /api/auth/mfa/enroll — start TOTP setup (returns QR + secret)
router.post(
  "/mfa/enroll",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.accessToken) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const refreshToken = readRefreshToken(req);
    if (!refreshToken) {
      return res.status(400).json({ success: false, message: "refreshToken is required" });
    }

    try {
      const enrollment = await enrollTotp(req.accessToken, refreshToken);
      return res.json({ success: true, data: enrollment });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : "Could not start authenticator setup",
      });
    }
  })
);

// POST /api/auth/mfa/verify-enrollment — confirm setup with a code from the app
router.post(
  "/mfa/verify-enrollment",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.accessToken) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const refreshToken = readRefreshToken(req);
    const factorId = typeof (req.body as { factorId?: unknown })?.factorId === "string"
      ? (req.body as { factorId: string }).factorId
      : "";
    const code = readMfaCode(req);

    if (!refreshToken) {
      return res.status(400).json({ success: false, message: "refreshToken is required" });
    }
    if (!factorId || !code) {
      return res.status(400).json({ success: false, message: "factorId and code are required" });
    }

    try {
      const tokens = await verifyTotpEnrollment(req.accessToken, refreshToken, { factorId, code });
      return res.json({
        success: true,
        message: "Authenticator enabled",
        data: { tokens },
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : "Invalid authenticator code",
      });
    }
  })
);

// POST /api/auth/mfa/cancel-enrollment
router.post(
  "/mfa/cancel-enrollment",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.accessToken) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const refreshToken = readRefreshToken(req);
    const factorId = typeof (req.body as { factorId?: unknown })?.factorId === "string"
      ? (req.body as { factorId: string }).factorId
      : "";

    if (!refreshToken || !factorId) {
      return res.status(400).json({ success: false, message: "refreshToken and factorId are required" });
    }

    try {
      await cancelTotpEnrollment(req.accessToken, refreshToken, factorId);
      return res.json({ success: true, message: "Authenticator setup cancelled" });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : "Could not cancel setup",
      });
    }
  })
);

// POST /api/auth/mfa/disable — requires a current authenticator code
router.post(
  "/mfa/disable",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.accessToken) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const refreshToken = readRefreshToken(req);
    const factorId = typeof (req.body as { factorId?: unknown })?.factorId === "string"
      ? (req.body as { factorId: string }).factorId
      : "";
    const code = readMfaCode(req);

    if (!refreshToken) {
      return res.status(400).json({ success: false, message: "refreshToken is required" });
    }
    if (!factorId || !code) {
      return res.status(400).json({ success: false, message: "factorId and code are required" });
    }

    try {
      await disableTotp(req.accessToken, refreshToken, { factorId, code });
      return res.json({ success: true, message: "Authenticator disabled" });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : "Could not disable authenticator",
      });
    }
  })
);

// POST /api/auth/mfa/verify-login — finish sign-in after password when MFA is on
router.post(
  "/mfa/verify-login",
  asyncHandler(async (req, res) => {
    const accessToken =
      typeof (req.body as { accessToken?: unknown })?.accessToken === "string"
        ? (req.body as { accessToken: string }).accessToken
        : "";
    const refreshToken = readRefreshToken(req);
    const factorId = typeof (req.body as { factorId?: unknown })?.factorId === "string"
      ? (req.body as { factorId: string }).factorId
      : "";
    const code = readMfaCode(req);

    if (!accessToken || !refreshToken) {
      return res.status(400).json({ success: false, message: "accessToken and refreshToken are required" });
    }
    if (!factorId || !code) {
      return res.status(400).json({ success: false, message: "factorId and code are required" });
    }

    try {
      const tokens = await verifyLoginTotp(accessToken, refreshToken, { factorId, code });
      const { data: userData, error: userError } = await supabase.auth.getUser(tokens.access_token);
      if (userError || !userData.user) {
        return res.status(401).json({ success: false, message: "Could not load user after MFA" });
      }

      await rememberSessionDevice(userData.user.id, tokens.access_token, req);

      return res.json({
        success: true,
        message: "Logged in",
        data: await sessionResponse(
          {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: tokens.expires_at,
          },
          userData.user
        ),
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : "Invalid authenticator code",
      });
    }
  })
);

// GET /api/auth/me
router.get(
  "/me",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const onboardingCompleted = req.user?.id ? await getOnboardingCompleted(req.user.id) : false;
    return res.json({ success: true, data: { user: req.user, onboardingCompleted } });
  })
);

// PATCH /api/auth/profile
router.patch(
  "/profile",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const firstName = typeof req.body?.firstName === "string" ? req.body.firstName.trim() : "";
    const lastName = typeof req.body?.lastName === "string" ? req.body.lastName.trim() : "";
    const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";

    if (!firstName && !lastName) {
      return res.status(400).json({ success: false, message: "Add at least a first or last name" });
    }

    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    const existingMeta = (req.user?.user_metadata ?? {}) as Record<string, unknown>;

    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      user_metadata: {
        ...existingMeta,
        first_name: firstName,
        last_name: lastName,
        full_name: fullName,
        phone,
      },
    });

    if (error || !data.user) {
      return res.status(400).json({ success: false, message: error?.message || "Failed to update profile" });
    }

    const onboardingCompleted = await getOnboardingCompleted(userId);

    return res.json({
      success: true,
      message: "Profile updated",
      data: { user: data.user, onboardingCompleted },
    });
  })
);

// POST /api/auth/avatar
router.post(
  "/avatar",
  authenticateToken,
  (req, res, next) => {
    avatarUpload.single("avatar")(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, message: err.message || "Invalid file upload" });
      }
      next();
    });
  },
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
    if (!file) {
      return res.status(400).json({ success: false, message: "No image file provided" });
    }

    try {
      const user = await uploadAvatar(userId, { buffer: file.buffer, mimetype: file.mimetype });
      return res.json({ success: true, message: "Profile photo updated", data: { user } });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : "Failed to upload profile photo",
      });
    }
  })
);

// DELETE /api/auth/avatar
router.delete(
  "/avatar",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    try {
      const user = await deleteAvatar(userId);
      return res.json({ success: true, message: "Profile photo removed", data: { user } });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : "Failed to remove profile photo",
      });
    }
  })
);

// POST /api/auth/change-password
router.post(
  "/change-password",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const email = req.user?.email;
    const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
    const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";

    if (!email) {
      return res.status(400).json({ success: false, message: "Authenticated user email is required" });
    }
    if (!currentPassword) {
      return res.status(400).json({ success: false, message: "Current password is required" });
    }
    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
    }

    const { data: verifyData, error: verifyError } = await supabase.auth.signInWithPassword({
      email,
      password: currentPassword,
    });

    if (verifyError) {
      return res.status(400).json({ success: false, message: "Current password is incorrect" });
    }

    // Password check creates a throwaway session — drop it so it doesn't show as a device.
    if (verifyData.session?.access_token) {
      await supabaseAdmin.auth.admin.signOut(verifyData.session.access_token, "local");
    }

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(req.user!.id, {
      password: newPassword,
    });

    if (updateError) {
      return res.status(400).json({ success: false, message: updateError.message });
    }

    return res.json({ success: true, message: "Password updated" });
  })
);

// DELETE /api/auth/account — permanently delete the signed-in user and cascaded data
router.delete(
  "/account",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id;
    const email = req.user?.email;
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!userId || !email) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    if (!password) {
      return res.status(400).json({ success: false, message: "Password is required to delete your account" });
    }

    const { data: verifyData, error: verifyError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (verifyError) {
      return res.status(400).json({ success: false, message: "Password is incorrect" });
    }

    if (verifyData.session?.access_token) {
      await supabaseAdmin.auth.admin.signOut(verifyData.session.access_token, "local");
    }

    try {
      await deleteUserAccount(userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not delete account";
      return res.status(500).json({ success: false, message });
    }

    return res.json({ success: true, message: "Account deleted" });
  })
);

// POST /api/auth/forgot-password
router.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    const { email } = req.body ?? {};

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "A valid email is required" });
    }

    // Never reveal whether the email exists - always respond with success.
    await supabase.auth.resetPasswordForEmail(email);

    return res.json({
      success: true,
      message: "If an account exists for that email, a reset code has been sent.",
    });
  })
);

// POST /api/auth/reset-password
router.post(
  "/reset-password",
  asyncHandler(async (req, res) => {
    const { email, token, newPassword } = req.body ?? {};

    if (!isValidEmail(email) || typeof token !== "string" || token.length === 0) {
      return res.status(400).json({ success: false, message: "Email and reset code are required" });
    }
    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
    }

    const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "recovery" });

    if (error || !data.user) {
      return res.status(400).json({ success: false, message: error?.message || "Invalid or expired code" });
    }

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(data.user.id, {
      password: newPassword,
    });

    if (updateError) {
      return res.status(400).json({ success: false, message: updateError.message });
    }

    return res.json({ success: true, message: "Password updated. You can now log in." });
  })
);

export default router;

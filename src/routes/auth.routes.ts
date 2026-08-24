import { Router } from "express";
import multer from "multer";
import { supabase, supabaseAdmin } from "../config/supabase";
import { asyncHandler } from "../middleware/errorHandler";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { getOnboardingCompleted, uploadAvatar, deleteAvatar } from "../services/profile";

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

function isValidPassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= 8;
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

    const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "signup" });

    if (error || !data.session) {
      return res.status(400).json({ success: false, message: error?.message || "Invalid or expired code" });
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

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.session) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

            return res.json({
              success: true,
              message: "Logged in",
              data: await sessionResponse(data.session, data.user),
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

    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });

    if (error || !data.session) {
      return res.status(401).json({ success: false, message: "Invalid or expired refresh token" });
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
      // Revokes the refresh token server-side so the access token can't be renewed.
      await supabaseAdmin.auth.admin.signOut(req.accessToken, "global");
    }
    return res.json({ success: true, message: "Logged out" });
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

    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email,
      password: currentPassword,
    });

    if (verifyError) {
      return res.status(401).json({ success: false, message: "Current password is incorrect" });
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

import { Router } from "express";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { requireAdmin } from "../middleware/admin";
import { asyncHandler } from "../middleware/errorHandler";
import {
  addStaffAdmin,
  changeAdminPassword,
  createAdminSessionToken,
  isAdminEmail,
  isAdminPasswordConfigured,
  listAdminActivity,
  listAdminCreditEvents,
  listAdminPayments,
  listAdminSupport,
  listAdminUsers,
  listStaffAdmins,
  setAdminPassword,
  validateAdminPasswordStrength,
  verifyAdminPassword,
} from "../services/admin";
import { logAccountAudit } from "../services/accountAudit";

const router = Router();

// GET /api/admin/status — allowlisted admin only
router.get(
  "/status",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const email = req.user?.email;
    if (!req.user?.id || !(await isAdminEmail(email))) {
      return res.status(403).json({ success: false, message: "Admin access required" });
    }
    const passwordSet = await isAdminPasswordConfigured();
    return res.json({
      success: true,
      data: { passwordSet },
    });
  })
);

// POST /api/admin/unlock — allowlisted admin + password (or first-time set)
router.post(
  "/unlock",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const email = req.user?.email;
    if (!req.user?.id || !(await isAdminEmail(email))) {
      return res.status(403).json({ success: false, message: "Admin access required" });
    }

    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const confirmPassword =
      typeof req.body?.confirmPassword === "string" ? req.body.confirmPassword : "";
    const passwordSet = await isAdminPasswordConfigured();

    if (!passwordSet) {
      const strengthError = validateAdminPasswordStrength(password);
      if (strengthError) {
        return res.status(400).json({ success: false, message: strengthError });
      }
      if (password !== confirmPassword) {
        return res.status(400).json({
          success: false,
          message: "Password confirmation does not match.",
        });
      }
      await setAdminPassword(password, req.user.id);
      const session = createAdminSessionToken(req.user.id, email!);
      await logAccountAudit({
        userId: req.user.id,
        action: "admin.password_set",
        actor: "user",
        metadata: { email },
      });
      return res.json({
        success: true,
        data: {
          adminToken: session.token,
          expiresAt: session.expiresAt,
          passwordSet: true,
        },
      });
    }

    if (!(await verifyAdminPassword(password))) {
      await logAccountAudit({
        userId: req.user.id,
        action: "admin.unlock_failed",
        actor: "user",
        metadata: { email },
      });
      return res.status(401).json({ success: false, message: "Wrong admin password" });
    }

    const session = createAdminSessionToken(req.user.id, email!);
    await logAccountAudit({
      userId: req.user.id,
      action: "admin.unlock",
      actor: "user",
      metadata: { email },
    });

    return res.json({
      success: true,
      data: {
        adminToken: session.token,
        expiresAt: session.expiresAt,
        passwordSet: true,
      },
    });
  })
);

// POST /api/admin/password — change unlock password while unlocked
router.post(
  "/password",
  authenticateToken,
  requireAdmin,
  asyncHandler(async (req: AuthRequest, res) => {
    const currentPassword =
      typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
    const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
    const confirmPassword =
      typeof req.body?.confirmPassword === "string" ? req.body.confirmPassword : "";

    const strengthError = validateAdminPasswordStrength(newPassword);
    if (strengthError) {
      return res.status(400).json({ success: false, message: strengthError });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Password confirmation does not match.",
      });
    }

    try {
      await changeAdminPassword(currentPassword, newPassword, req.user!.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not change admin password.";
      const status = message.includes("wrong") ? 401 : 400;
      return res.status(status).json({ success: false, message });
    }

    await logAccountAudit({
      userId: req.user!.id,
      action: "admin.password_changed",
      actor: "user",
      metadata: { email: req.user?.email },
    });

    return res.json({
      success: true,
      data: { passwordSet: true },
      message: "Admin password updated.",
    });
  })
);

// GET /api/admin/staff — list platform admins
router.get(
  "/staff",
  authenticateToken,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const staff = await listStaffAdmins();
    return res.json({ success: true, data: { staff } });
  })
);

// POST /api/admin/staff — add another admin by email
router.post(
  "/staff",
  authenticateToken,
  requireAdmin,
  asyncHandler(async (req: AuthRequest, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    try {
      const added = await addStaffAdmin(email, req.user!.id);
      await logAccountAudit({
        userId: req.user!.id,
        action: "admin.staff_added",
        actor: "user",
        metadata: { email: added.email, addedBy: req.user?.email },
      });
      return res.status(201).json({ success: true, data: { admin: added } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not add admin.";
      const status = /already an admin/i.test(message) ? 409 : 400;
      return res.status(status).json({ success: false, message });
    }
  })
);

// GET /api/admin/overview
router.get(
  "/overview",
  authenticateToken,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const settled = await Promise.allSettled([
      listAdminUsers(100),
      listAdminPayments(100),
      listAdminCreditEvents(100),
      listAdminActivity(100),
      listAdminSupport(50),
      listStaffAdmins(),
    ]);

    const value = <T>(result: PromiseSettledResult<T>, fallback: T): T =>
      result.status === "fulfilled" ? result.value : fallback;

    const users = value(settled[0], []);
    const payments = value(settled[1], []);
    const credits = value(settled[2], []);
    const activity = value(settled[3], []);
    const support = value(settled[4], []);
    const staff = value(settled[5], []);

    for (const result of settled) {
      if (result.status === "rejected") {
        console.warn("[admin/overview]", result.reason);
      }
    }

    return res.json({
      success: true,
      data: {
        users,
        payments,
        credits,
        activity,
        support,
        staff,
        counts: {
          users: users.length,
          paidPlans: payments.filter((p) => p.planId !== "free").length,
          openSupport: support.filter((t) => t.status === "open").length,
          creditEvents: credits.length,
          activity: activity.length,
          staff: staff.length,
        },
      },
    });
  })
);

export default router;

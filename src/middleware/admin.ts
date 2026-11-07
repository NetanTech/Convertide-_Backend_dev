import type { NextFunction, Response } from "express";
import type { AuthRequest } from "./auth";
import { isAdminEmail, verifyAdminSessionToken } from "../services/admin";

/**
 * Requires a signed-in allowlisted admin who unlocked the admin console
 * (Bearer + X-Admin-Token).
 */
export async function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  const email = req.user?.email;
  if (!req.user?.id || !(await isAdminEmail(email))) {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }

  const header = req.headers["x-admin-token"];
  const token = typeof header === "string" ? header : "";
  const verified = await verifyAdminSessionToken(token, req.user.id);
  if (!verified) {
    return res.status(401).json({
      success: false,
      message: "Admin unlock required. Enter the admin password.",
      code: "ADMIN_UNLOCK_REQUIRED",
    });
  }

  return next();
}

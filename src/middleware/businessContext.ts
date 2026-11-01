import type { NextFunction, Response } from "express";
import type { AuthRequest } from "./auth";
import { resolveBusinessContext, type BusinessProfile } from "../services/businessProfiles";

export type BusinessAuthRequest = AuthRequest & {
  businessId?: string;
  business?: BusinessProfile;
};

/**
 * After authenticateToken — resolves the active business and attaches it.
 * Rejects foreign X-Business-Id values with 403 (audited).
 */
export async function attachBusinessContext(
  req: BusinessAuthRequest,
  _res: Response,
  next: NextFunction
) {
  try {
    if (!req.user?.id) {
      const err = new Error("Unauthorized") as Error & { status?: number };
      err.status = 401;
      throw err;
    }

    const header = req.headers["x-business-id"];
    const headerId = typeof header === "string" ? header.trim() : null;
    const business = await resolveBusinessContext(req.user.id, headerId || null);
    req.businessId = business.id;
    req.business = business;
    next();
  } catch (err) {
    next(err);
  }
}

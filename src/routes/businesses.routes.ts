import { Router } from "express";
import { z } from "zod";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import {
  createBusinessProfile,
  ensureDefaultBusiness,
  listBusinessProfiles,
  setActiveBusiness,
  updateBusinessProfile,
} from "../services/businessProfiles";

const router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(120),
  industry: z.string().max(120).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  industry: z.string().max(120).optional(),
});

// GET /api/businesses
router.get(
  "/",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    await ensureDefaultBusiness(req.user!.id);
    const businesses = await listBusinessProfiles(req.user!.id);
    const active =
      businesses.find((b) => b.isDefault) ??
      businesses[0] ??
      null;

    // Prefer profiles.active_business_id when present among the list
    const { getActiveBusinessId } = await import("../services/businessProfiles");
    const activeId = await getActiveBusinessId(req.user!.id);
    const current = businesses.find((b) => b.id === activeId) ?? active;

    return res.json({
      success: true,
      data: {
        businesses,
        activeBusinessId: current?.id ?? null,
      },
    });
  })
);

// POST /api/businesses
router.post(
  "/",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || "Invalid business payload",
      });
    }

    const business = await createBusinessProfile(req.user!.id, parsed.data);
    return res.status(201).json({ success: true, data: { business } });
  })
);

// PATCH /api/businesses/:id
router.patch(
  "/:id",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || "Invalid business payload",
      });
    }

    const id = String(req.params.id);
    const business = await updateBusinessProfile(req.user!.id, id, parsed.data);
    return res.json({ success: true, data: { business } });
  })
);

// POST /api/businesses/:id/activate
router.post(
  "/:id/activate",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const id = String(req.params.id);
    const business = await setActiveBusiness(req.user!.id, id);
    return res.json({
      success: true,
      message: `Switched to ${business.name}`,
      data: { business, activeBusinessId: business.id },
    });
  })
);

export default router;

import { Router } from "express";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import { settingsUpdateSchema } from "../schemas/settings.schema";
import { ensureUserSettings, updateUserSettings } from "../services/settings";

const router = Router();

// GET /api/settings
router.get(
  "/",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const settings = await ensureUserSettings(req.user!.id);
    return res.json({ success: true, data: { settings } });
  })
);

// PATCH /api/settings
router.patch(
  "/",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = settingsUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || "Invalid settings payload",
      });
    }

    const settings = await updateUserSettings(req.user!.id, parsed.data);
    return res.json({ success: true, message: "Preferences saved", data: { settings } });
  })
);

export default router;

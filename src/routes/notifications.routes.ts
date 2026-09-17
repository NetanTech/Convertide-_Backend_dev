import { Router } from "express";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import { notificationCategorySchema } from "../schemas/notification.schema";
import {
  dismissNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../services/notifications";

const router = Router();

// GET /api/notifications?category=all|campaigns|ai|billing
router.get(
  "/",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const categoryParam = typeof req.query.category === "string" ? req.query.category : "all";
    if (categoryParam !== "all") {
      const parsed = notificationCategorySchema.safeParse(categoryParam);
      if (!parsed.success) {
        return res.status(400).json({ success: false, message: "Invalid category" });
      }
    }

    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "10"), 10) || 10));
    const highlightId = typeof req.query.highlightId === "string" ? req.query.highlightId : undefined;

    const result = await listNotifications(req.user!.id, {
      category: categoryParam,
      page,
      limit,
      highlightId,
    });

    return res.json({
      success: true,
      data: result,
    });
  })
);

// POST /api/notifications/mark-all-read
router.post(
  "/mark-all-read",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    await markAllNotificationsRead(req.user!.id);
    return res.json({ success: true, message: "All notifications marked as read" });
  })
);

// PATCH /api/notifications/:id/read
router.patch(
  "/:id/read",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const id = String(req.params.id);
    const notification = await markNotificationRead(req.user!.id, id);
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    return res.json({ success: true, data: { notification } });
  })
);

// DELETE /api/notifications/:id  (soft dismiss)
router.delete(
  "/:id",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const id = String(req.params.id);
    const ok = await dismissNotification(req.user!.id, id);
    if (!ok) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    return res.json({ success: true, message: "Notification dismissed" });
  })
);

export default router;

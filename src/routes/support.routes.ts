import { Router } from "express";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import { supportContactSchema, supportMessageSchema } from "../schemas/support.schema";
import {
  getHelpContent,
  getOpenTicket,
  sendSupportChatMessage,
  submitSupportContact,
} from "../services/support";

const router = Router();

// GET /api/support/help — articles, FAQs, booking URL, support email
router.get(
  "/help",
  authenticateToken,
  asyncHandler(async (_req: AuthRequest, res) => {
    return res.json({
      success: true,
      data: getHelpContent(),
    });
  })
);

// GET /api/support/ticket — current open chat thread (or null)
router.get(
  "/ticket",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const ticket = await getOpenTicket(req.user!.id);
    return res.json({
      success: true,
      data: { ticket },
    });
  })
);

// POST /api/support/messages — send chat message (creates ticket if needed)
router.post(
  "/messages",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = supportMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || "Invalid message",
      });
    }

    const ticket = await sendSupportChatMessage(req.user!.id, parsed.data);
    return res.json({
      success: true,
      message: "Message sent",
      data: { ticket },
    });
  })
);

// POST /api/support/contact — email support form
router.post(
  "/contact",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = supportContactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || "Invalid contact form",
      });
    }

    const result = await submitSupportContact(req.user!.id, parsed.data);
    return res.json({
      success: true,
      message: "Message sent to support",
      data: result,
    });
  })
);

export default router;

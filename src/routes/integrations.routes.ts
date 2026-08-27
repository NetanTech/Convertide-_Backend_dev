import { Router } from "express";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import {
  buildAuthorizeUrl,
  connectDemo,
  disconnectIntegration,
  frontendIntegrationsRedirect,
  handleOAuthCallback,
  isDemoMode,
  isProviderConfigured,
  listIntegrations,
  type IntegrationProvider,
} from "../services/integrations";

const router = Router();

const PROVIDERS = new Set<IntegrationProvider>(["instagram", "facebook", "tiktok", "linkedin"]);

function parseProvider(value: string): IntegrationProvider | null {
  return PROVIDERS.has(value as IntegrationProvider) ? (value as IntegrationProvider) : null;
}

// GET /api/integrations
router.get(
  "/",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const integrations = await listIntegrations(req.user!.id);
    return res.json({
      success: true,
      data: {
        integrations,
        demoMode: isDemoMode(),
      },
    });
  })
);

// POST /api/integrations/:provider/connect
// Returns { authUrl } for OAuth, or connects immediately in INTEGRATIONS_DEMO_MODE.
router.post(
  "/:provider/connect",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const provider = parseProvider(String(req.params.provider));
    if (!provider) {
      return res.status(400).json({ success: false, message: "Unknown integration provider" });
    }

    if (!isProviderConfigured(provider)) {
      return res.status(503).json({
        success: false,
        message: `${provider} OAuth is not configured. Add provider credentials (or INTEGRATIONS_DEMO_MODE=true) to the backend .env.`,
      });
    }

    try {
      const authUrl = buildAuthorizeUrl(req.user!.id, provider);
      return res.json({ success: true, data: { authUrl } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not start connect";
      if (message === "DEMO_CONNECT" || isDemoMode()) {
        await connectDemo(req.user!.id, provider);
        return res.json({ success: true, data: { connected: true, demo: true } });
      }
      return res.status(400).json({ success: false, message });
    }
  })
);

// DELETE /api/integrations/:provider
router.delete(
  "/:provider",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const provider = parseProvider(String(req.params.provider));
    if (!provider) {
      return res.status(400).json({ success: false, message: "Unknown integration provider" });
    }
    await disconnectIntegration(req.user!.id, provider);
    return res.json({ success: true, message: "Disconnected" });
  })
);

// GET /api/integrations/callback/:provider — OAuth redirect target (no auth header; state carries user)
router.get(
  "/callback/:provider",
  asyncHandler(async (req, res) => {
    const provider = parseProvider(String(req.params.provider));
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const oauthError = typeof req.query.error === "string" ? req.query.error : "";

    if (!provider) {
      return res.redirect(frontendIntegrationsRedirect({ error: "unknown_provider" }));
    }
    if (oauthError) {
      return res.redirect(frontendIntegrationsRedirect({ error: oauthError, provider }));
    }
    if (!code || !state) {
      return res.redirect(frontendIntegrationsRedirect({ error: "missing_code", provider }));
    }

    try {
      await handleOAuthCallback(provider, code, state);
      return res.redirect(frontendIntegrationsRedirect({ connected: provider }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "connect_failed";
      return res.redirect(
        frontendIntegrationsRedirect({
          error: "connect_failed",
          provider,
          detail: message.slice(0, 120),
        })
      );
    }
  })
);

export default router;

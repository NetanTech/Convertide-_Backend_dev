import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";

import authRoutes from "./routes/auth.routes";
import personasRoutes from "./routes/personas.routes";
import settingsRoutes from "./routes/settings.routes";
import notificationsRoutes from "./routes/notifications.routes";
import campaignsRoutes from "./routes/campaigns.routes";
import plansRoutes from "./routes/plans.routes";
import assetsRoutes from "./routes/assets.routes";
import billingRoutes from "./routes/billing.routes";
import dashboardRoutes from "./routes/dashboard.routes";
import integrationsRoutes from "./routes/integrations.routes";
import supportRoutes from "./routes/support.routes";
import { globalErrorHandler, notFoundHandler, asyncHandler } from "./middleware/errorHandler";
import { handleStripeWebhook } from "./services/stripe";

dotenv.config();

const app = express();

// This is a JSON API, not a set of cacheable static resources — disable
// Express's default ETag generation and force no-store on every response.
// Without this, an identical GET request fired twice in quick succession
// (e.g. React's dev-mode double-invoked effects) gets a 304 Not Modified
// with an empty body for the second call, which the frontend can't parse
// as JSON and treats as a failed request.
app.set("etag", false);
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim());

app.use(helmet());
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

// Stripe webhooks need the raw body for signature verification — mount before json().
app.post(
  "/api/billing/webhook",
  express.raw({ type: "application/json" }),
  asyncHandler(async (req, res) => {
    const signature = req.headers["stripe-signature"];
    const result = await handleStripeWebhook(
      Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body)),
      typeof signature === "string" ? signature : undefined
    );
    return res.json(result);
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

app.get("/health", (_req, res) => {
  res.json({ success: true, message: "Convertide API is running" });
});

app.use("/api/auth", authRoutes);
app.use("/api/personas", personasRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/campaigns", campaignsRoutes);
app.use("/api/plans", plansRoutes);
app.use("/api/assets", assetsRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/integrations", integrationsRoutes);
app.use("/api/support", supportRoutes);

app.use(notFoundHandler);
app.use(globalErrorHandler);

const PORT = process.env.PORT ? Number(process.env.PORT) : 4210;

app.listen(PORT, () => {
  console.log(`Convertide API listening on http://localhost:${PORT}`);
});

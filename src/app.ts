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
import { globalErrorHandler, notFoundHandler } from "./middleware/errorHandler";

dotenv.config();

const app = express();

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

app.use(notFoundHandler);
app.use(globalErrorHandler);

const PORT = process.env.PORT ? Number(process.env.PORT) : 4210;

app.listen(PORT, () => {
  console.log(`Convertide API listening on http://localhost:${PORT}`);
});

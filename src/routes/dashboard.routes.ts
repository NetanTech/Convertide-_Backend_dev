import { Router } from "express";
import { supabaseAdmin } from "../config/supabase";
import { authenticateToken } from "../middleware/auth";
import { attachBusinessContext, type BusinessAuthRequest } from "../middleware/businessContext";
import { asyncHandler } from "../middleware/errorHandler";
import { ensureBillingAccount, getMonthlyCreditUsage } from "../services/billing";

const router = Router();

// GET /api/dashboard/summary
router.get(
  "/summary",
  authenticateToken,
  attachBusinessContext,
  asyncHandler(async (req: BusinessAuthRequest, res) => {
    const userId = req.user!.id;
    const businessId = req.businessId!;
    const year = Math.max(
      2020,
      Math.min(2100, parseInt(String(req.query.year ?? new Date().getUTCFullYear()), 10) || new Date().getUTCFullYear())
    );

    const [
      personasCountRes,
      campaignsActiveRes,
      plansActiveRes,
      recentPersonasRes,
      recentNotificationsRes,
      account,
      creditsUsage,
    ] = await Promise.all([
      supabaseAdmin
        .from("personas")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("business_id", businessId),
      supabaseAdmin
        .from("campaigns")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("business_id", businessId)
        .eq("status", "active"),
      supabaseAdmin
        .from("plans")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("business_id", businessId)
        .eq("status", "Active"),
      supabaseAdmin
        .from("personas")
        .select("id, name, created_at")
        .eq("user_id", userId)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .limit(4),
      supabaseAdmin
        .from("notifications")
        .select("id, category, title, description, created_at, action_href")
        .eq("user_id", userId)
        .is("dismissed_at", null)
        .order("created_at", { ascending: false })
        .limit(12),
      ensureBillingAccount(userId),
      getMonthlyCreditUsage(userId, year, businessId),
    ]);

    if (personasCountRes.error) {
      return res.status(500).json({ success: false, message: personasCountRes.error.message });
    }
    if (campaignsActiveRes.error) {
      return res.status(500).json({ success: false, message: campaignsActiveRes.error.message });
    }
    if (plansActiveRes.error) {
      return res.status(500).json({ success: false, message: plansActiveRes.error.message });
    }
    if (recentPersonasRes.error) {
      return res.status(500).json({ success: false, message: recentPersonasRes.error.message });
    }
    if (recentNotificationsRes.error) {
      return res.status(500).json({ success: false, message: recentNotificationsRes.error.message });
    }

    const recentPersonas = (recentPersonasRes.data ?? []).map((row) => ({
      id: row.id as string,
      name: row.name as string,
      updatedAt: row.created_at as string,
      status: "completed" as const,
    }));

    const recentActivities = (recentNotificationsRes.data ?? []).map((row) => ({
      id: row.id as string,
      category: row.category as string,
      title: row.title as string,
      subtitle: row.description as string,
      href: (row.action_href as string) || undefined,
      createdAt: row.created_at as string,
    }));

    return res.json({
      success: true,
      data: {
        stats: {
          totalPersonas: personasCountRes.count ?? 0,
          activeCampaigns: campaignsActiveRes.count ?? 0,
          activePlans: plansActiveRes.count ?? 0,
        },
        credits: {
          // Business-scoped usage; plan total still comes from the billing account.
          used: req.business?.creditsUsed ?? account.credits_used,
          total: req.business?.creditsTotal ?? account.credits_total,
          accountUsed: account.credits_used,
          accountTotal: account.credits_total,
          businessId: businessId,
        },
        creditsUsage: {
          year,
          months: creditsUsage,
        },
        recentPersonas,
        recentActivities,
      },
    });
  })
);

export default router;

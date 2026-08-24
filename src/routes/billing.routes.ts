import { Router } from "express";
import { supabaseAdmin } from "../config/supabase";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import { createNotification } from "../services/notifications";
import {
  addPaymentMethod,
  changePlan,
  deletePaymentMethod,
  ensureBillingAccount,
  getTierCatalog,
  listPaymentMethods,
  setPrimaryPaymentMethod,
  toPaymentMethod,
  updateBillingAddress,
  type BillingAccountRow,
  type PlanTierId,
} from "../services/billing";
import {
  addPaymentMethodSchema,
  changePlanSchema,
  updateBillingAddressSchema,
} from "../schemas/billing.schema";

const router = Router();

type InvoiceRow = {
  id: string;
  invoice_date: string;
  description: string;
  amount: string;
  status: "paid" | "pending" | "failed";
};

function billingAddressFromAccount(account: BillingAccountRow) {
  if (!account.billing_line1) return null;
  return {
    company: account.billing_company ?? "",
    line1: account.billing_line1,
    line2: account.billing_line2 ?? "",
    city: account.billing_city ?? "",
    state: account.billing_state ?? "",
    postalCode: account.billing_postal_code ?? "",
    country: account.billing_country ?? "",
  };
}

// GET /api/billing
router.get(
  "/",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const account = await ensureBillingAccount(req.user!.id);

    const { data: invoices, error } = await supabaseAdmin
      .from("billing_invoices")
      .select("*")
      .eq("user_id", req.user!.id)
      .order("invoice_date", { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });

    const billing = {
      plan: {
        name: account.plan_name,
        price: account.plan_price,
        cycle: account.plan_cycle,
        renewsOn: account.renews_on,
      },
      credits: {
        used: account.credits_used,
        total: account.credits_total,
      },
      paymentMethod:
        account.payment_brand && account.payment_last4
          ? {
              brand: account.payment_brand,
              last4: account.payment_last4,
              expiry: account.payment_expiry ?? "",
            }
          : null,
      billingAddress: billingAddressFromAccount(account),
      invoices: ((invoices as InvoiceRow[]) ?? []).map((invoice) => ({
        id: invoice.id,
        date: invoice.invoice_date,
        plan: invoice.description,
        amount: invoice.amount,
        status: invoice.status,
      })),
    };

    return res.json({ success: true, data: { billing } });
  })
);

// GET /api/billing/plans -> subscription overview: current plan, usage, tier comparison, payment methods
router.get(
  "/plans",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const account = await ensureBillingAccount(req.user!.id);
    const paymentMethods = await listPaymentMethods(req.user!.id);
    const catalog = getTierCatalog();
    const currentTierId = account.plan_id as PlanTierId;

    const tiers = (Object.keys(catalog) as PlanTierId[]).map((id) => {
      const tier = catalog[id];
      const isCurrent = id === currentTierId;

      let cta = `Switch to ${tier.name}`;
      let ctaHref: string | undefined = undefined;
      let ctaDisabled = false;

      if (id === "enterprise") {
        cta = "Talk to Sales";
        ctaHref = "/dashboard/settings";
      } else if (isCurrent) {
        cta = "Active Subscription";
        ctaDisabled = true;
      } else {
        const rank: Record<PlanTierId, number> = { pro: 0, scale: 1, enterprise: 2 };
        cta = rank[id] > rank[currentTierId] ? `Upgrade to ${tier.name}` : `Downgrade to ${tier.name}`;
      }

      return {
        id,
        name: tier.name,
        description: tier.description,
        price: tier.price,
        cycle: tier.cycle,
        features: tier.features,
        cta,
        ctaHref,
        ctaDisabled,
        highlighted: isCurrent,
      };
    });

    const subscription = {
      currentPlan: {
        id: currentTierId,
        name: account.plan_name,
        price: account.plan_price,
        cycle: account.plan_cycle,
        billingCycle: account.billing_cycle,
        renewsOn: account.renews_on,
      },
      usage: {
        seatsUsed: account.seats_used,
        seatsLimit: account.seats_limit,
        projects: account.projects,
        apiPriority: account.api_priority,
      },
      tiers,
      paymentMethods: paymentMethods.map(toPaymentMethod),
    };

    return res.json({ success: true, data: { subscription } });
  })
);

// POST /api/billing/change-plan
router.post(
  "/change-plan",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = changePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "A valid planId (pro or scale) is required" });
    }

    const account = await changePlan(req.user!.id, parsed.data.planId);

    await createNotification(req.user!.id, {
      category: "billing",
      title: "Plan Updated",
      description: `Your subscription is now on the ${account.plan_name} plan.`,
      actionLabel: "View Billing",
      actionHref: "/dashboard/billing",
      actionTone: "primary",
    });

    return res.json({
      success: true,
      message: `Switched to the ${account.plan_name} plan`,
      data: {
        currentPlan: {
          id: account.plan_id,
          name: account.plan_name,
          price: account.plan_price,
          cycle: account.plan_cycle,
          billingCycle: account.billing_cycle,
          renewsOn: account.renews_on,
        },
      },
    });
  })
);

// GET /api/billing/payment-methods
router.get(
  "/payment-methods",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const methods = await listPaymentMethods(req.user!.id);
    return res.json({ success: true, data: { paymentMethods: methods.map(toPaymentMethod) } });
  })
);

// POST /api/billing/payment-methods
router.post(
  "/payment-methods",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = addPaymentMethodSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Invalid payment method payload" });
    }

    const method = await addPaymentMethod(req.user!.id, parsed.data);
    return res.status(201).json({ success: true, data: { paymentMethod: toPaymentMethod(method) } });
  })
);

// DELETE /api/billing/payment-methods/:id
router.delete(
  "/payment-methods/:id",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const ok = await deletePaymentMethod(req.user!.id, req.params.id);
    if (!ok) return res.status(404).json({ success: false, message: "Payment method not found" });
    return res.json({ success: true, message: "Payment method removed" });
  })
);

// PATCH /api/billing/payment-methods/:id/primary
router.patch(
  "/payment-methods/:id/primary",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const method = await setPrimaryPaymentMethod(req.user!.id, req.params.id);
    if (!method) return res.status(404).json({ success: false, message: "Payment method not found" });
    return res.json({ success: true, data: { paymentMethod: toPaymentMethod(method) } });
  })
);

// PATCH /api/billing/address
router.patch(
  "/address",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = updateBillingAddressSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || "Invalid billing address",
      });
    }

    const account = await updateBillingAddress(req.user!.id, parsed.data);
    return res.json({
      success: true,
      message: "Billing address updated",
      data: { billingAddress: billingAddressFromAccount(account) },
    });
  })
);

export default router;

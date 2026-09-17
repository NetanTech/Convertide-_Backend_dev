import { Router } from "express";
import { supabaseAdmin } from "../config/supabase";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import { createNotification } from "../services/notifications";
import {
  activeSubscriptionProvider,
  addPaymentMethod,
  changePlan,
  deletePaymentMethod,
  ensureBillingAccount,
  formatPlanDate,
  getMonthlyCreditUsage,
  getTierCatalog,
  normalizePlanId,
  listPaymentMethods,
  setCancelAtPeriodEnd,
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
import {
  cancelSubscriptionAtPeriodEnd as paystackCancelAtPeriodEnd,
  createBillingPortalSession as createPaystackBillingPortalSession,
  createCreditsAddonCheckoutSession as createPaystackCreditsAddonCheckoutSession,
  createPlanCheckoutSession as createPaystackPlanCheckoutSession,
  verifyPaystackReference,
} from "../services/paystack";
import {
  cancelSubscriptionAtPeriodEnd as stripeCancelAtPeriodEnd,
  changePlanInPlace as stripeChangePlanInPlace,
  createBillingPortalSession as createStripeBillingPortalSession,
  createCreditsAddonCheckoutSession as createStripeCreditsAddonCheckoutSession,
  createPlanCheckoutSession as createStripePlanCheckoutSession,
  verifyStripeCheckoutSession,
} from "../services/stripe";
import { billingNotConfiguredMessage, checkoutProviderChoices, resolveBillingProvider, resolveBillingProviderForPortal } from "../services/billingProvider";
import type { BillingProvider, ClientRegionHint } from "../services/billingProvider";

const router = Router();

function userMetadataFrom(req: AuthRequest) {
  return (req.user as { user_metadata?: Record<string, unknown> } | undefined)?.user_metadata;
}

/**
 * Browser-derived location signal. Only consulted when the account has no billing
 * country or phone country on file, which is the case for most new users.
 */
function clientHintFrom(req: AuthRequest): ClientRegionHint {
  const timeZone = req.headers["x-client-timezone"];
  const acceptLanguage = req.headers["accept-language"];
  return {
    timeZone: typeof timeZone === "string" ? timeZone : null,
    acceptLanguage: typeof acceptLanguage === "string" ? acceptLanguage : null,
  };
}

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
        price: getTierCatalog()[account.plan_id as PlanTierId]?.price ?? account.plan_price,
        cycle: account.plan_cycle,
        renewsOn: account.renews_on,
        cancelAtPeriodEnd: account.cancel_at_period_end === true && account.plan_id !== "free",
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

    const cancelling = account.cancel_at_period_end === true && currentTierId !== "free";
    const pendingPlanId = account.pending_plan_id
      ? (normalizePlanId(account.pending_plan_id) as PlanTierId)
      : null;

    const tiers = (Object.keys(catalog) as PlanTierId[]).map((id) => {
      const tier = catalog[id];
      const isCurrent = id === currentTierId;

      let cta = `Switch to ${tier.name}`;
      let ctaHref: string | undefined = undefined;
      let ctaDisabled = false;

      if (isCurrent) {
        cta = cancelling ? "Renewal cancelled" : "Active Subscription";
        ctaDisabled = true;
      } else if (pendingPlanId === id) {
        // Already queued for the start of the next period.
        cta = "Scheduled";
        ctaDisabled = true;
      } else if (cancelling && id === "free") {
        // Already on the way to Free — nothing left to cancel.
        cta = "Scheduled";
        ctaDisabled = true;
      } else {
        const rank: Record<PlanTierId, number> = { free: 0, pro: 1, enterprise: 2 };
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

    const availableProviders = await checkoutProviderChoices(
      req.user!.id,
      userMetadataFrom(req),
      clientHintFrom(req)
    );

    const subscription = {
      currentPlan: {
        id: currentTierId,
        name: catalog[currentTierId].name,
        price: catalog[currentTierId].price,
        cycle: catalog[currentTierId].cycle || account.plan_cycle,
        billingCycle: cancelling ? "Renewal cancelled" : account.billing_cycle,
        renewsOn: account.renews_on,
        cancelAtPeriodEnd: cancelling,
        accessUntil: cancelling ? account.renews_on : null,
        pendingPlanId,
        pendingPlanName: pendingPlanId ? catalog[pendingPlanId].name : null,
        pendingPlanStartsOn: pendingPlanId ? account.pending_plan_starts_on : null,
      },
      usage: {
        seatsUsed: account.seats_used,
        seatsLimit: catalog[currentTierId].seatsLimit ?? account.seats_limit,
        projects: catalog[currentTierId].projects,
        apiPriority: catalog[currentTierId].apiPriority,
      },
      tiers,
      paymentMethods: paymentMethods.map(toPaymentMethod),
      availableProviders,
      /** Set once a subscription exists — tier changes then stay on this processor. */
      currentProvider: await activeSubscriptionProvider(req.user!.id),
    };

    return res.json({ success: true, data: { subscription } });
  })
);

/**
 * Turns off renewal at whichever processor holds the subscription, leaving the plan
 * usable until the paid period expires. Returns the date access runs out, if known.
 */
async function stopRenewalAtPeriodEnd(
  userId: string
): Promise<{ scheduled: boolean; periodEnd: string | null }> {
  const stripeResult = await stripeCancelAtPeriodEnd(userId);
  if (stripeResult.scheduled) return stripeResult;
  return paystackCancelAtPeriodEnd(userId);
}

// POST /api/billing/change-plan
router.post(
  "/change-plan",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = changePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "A valid planId (free, pro, or enterprise) is required" });
    }

    const provider = await resolveBillingProvider({
      userId: req.user!.id,
      preferred: parsed.data.provider ?? null,
      userMetadata: userMetadataFrom(req),
      clientHint: clientHintFrom(req),
    });
    const planId =
      parsed.data.planId === "scale" ? "enterprise" : parsed.data.planId;

    if (planId === "free" || !provider) {
      // Moving to Free means "stop renewing". The paid month has already been charged,
      // so the plan stays live until it runs out rather than being cut off here.
      if (planId === "free") {
        const current = await ensureBillingAccount(req.user!.id);

        let scheduled = false;
        let periodEnd: string | null = null;
        try {
          ({ scheduled, periodEnd } = await stopRenewalAtPeriodEnd(req.user!.id));
        } catch (err) {
          // Never fall through to an immediate downgrade: that would end their access
          // while the processor keeps charging.
          return res.status(400).json({
            success: false,
            message:
              err instanceof Error
                ? err.message
                : "Could not cancel your renewal. Please try again or contact support.",
          });
        }

        if (scheduled) {
          const accessUntil = periodEnd ?? current.renews_on;
          await setCancelAtPeriodEnd(req.user!.id, true, accessUntil);

          const readableDate = accessUntil
            ? new Date(accessUntil).toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })
            : null;

          await createNotification(req.user!.id, {
            category: "billing",
            title: "Renewal cancelled",
            description: readableDate
              ? `Your ${current.plan_name} plan won't renew. You keep full access until ${readableDate}.`
              : `Your ${current.plan_name} plan won't renew.`,
            actionLabel: "View Billing",
            actionHref: "/dashboard/billing",
            actionTone: "warning",
          });

          return res.json({
            success: true,
            message: readableDate
              ? `Renewal cancelled. You keep ${current.plan_name} access until ${readableDate}.`
              : "Renewal cancelled.",
            data: {
              currentPlan: {
                id: current.plan_id,
                name: current.plan_name,
                price: current.plan_price,
                cycle: current.plan_cycle,
                billingCycle: current.billing_cycle,
                renewsOn: accessUntil,
                cancelAtPeriodEnd: true,
                accessUntil,
              },
            },
          });
        }
      }

      // Nothing to cancel (already Free, or no processor configured) — switch outright.
      const account = await changePlan(req.user!.id, planId);
      await setCancelAtPeriodEnd(req.user!.id, false);

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
            cancelAtPeriodEnd: false,
            accessUntil: null,
          },
        },
      });
    }

    // Paid plans go through Stripe or Paystack Checkout when configured.
    try {
      const email = req.user?.email;
      if (!email) {
        return res.status(400).json({ success: false, message: "Account email is required for checkout" });
      }

      // An existing Stripe subscriber switches tier on the subscription itself. A second
      // checkout would bill the whole new plan on top of the period already paid for.
      if (provider === "stripe") {
        const change = await stripeChangePlanInPlace(req.user!.id, planId as "pro" | "enterprise");
        if (change) {
          const account = await ensureBillingAccount(req.user!.id);
          const tierName = getTierCatalog()[change.planId].name;
          const effectiveOn = formatPlanDate(change.effectiveAt);

          return res.json({
            success: true,
            message:
              change.effective === "immediate"
                ? `You're on ${tierName} now — only the difference for the rest of this period was charged.`
                : effectiveOn
                  ? `${tierName} starts ${effectiveOn}. You keep your current plan until then.`
                  : `${tierName} starts at the end of this billing period.`,
            data: {
              effective: change.effective,
              effectiveAt: change.effectiveAt,
              currentPlan: {
                id: account.plan_id,
                name: account.plan_name,
                price: account.plan_price,
                cycle: account.plan_cycle,
                billingCycle: account.billing_cycle,
                renewsOn: account.renews_on,
                cancelAtPeriodEnd: account.cancel_at_period_end === true,
                accessUntil: null,
                pendingPlanId: account.pending_plan_id,
                pendingPlanStartsOn: account.pending_plan_starts_on,
              },
            },
          });
        }
      }

      const session =
        provider === "stripe"
          ? await createStripePlanCheckoutSession({
              userId: req.user!.id,
              email,
              planId: planId as "pro" | "enterprise",
            })
          : await createPaystackPlanCheckoutSession({
              userId: req.user!.id,
              email,
              planId: planId as "pro" | "enterprise",
            });
      return res.json({
        success: true,
        message: provider === "stripe" ? "Continue in Stripe Checkout" : "Continue in Paystack Checkout",
        data: { checkoutUrl: session.url },
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : "Could not start checkout",
      });
    }
  })
);

// POST /api/billing/checkout — explicit plan checkout (Stripe or Paystack)
router.post(
  "/checkout",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = changePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "A valid planId (pro or enterprise) is required" });
    }

    const provider = await resolveBillingProvider({
      userId: req.user!.id,
      preferred: parsed.data.provider ?? null,
      userMetadata: userMetadataFrom(req),
      clientHint: clientHintFrom(req),
    });
    if (!provider) {
      return res.status(503).json({
        success: false,
        message: billingNotConfiguredMessage(),
      });
    }

    const planId =
      parsed.data.planId === "scale" ? "enterprise" : parsed.data.planId;

    if (planId === "free") {
      return res.status(400).json({ success: false, message: "The Free plan does not require checkout" });
    }

    const email = req.user?.email;
    if (!email) {
      return res.status(400).json({ success: false, message: "Account email is required for checkout" });
    }

    try {
      // Same reasoning as /change-plan: update the live subscription rather than
      // charging a fresh one on top of the period already paid for.
      if (provider === "stripe") {
        const change = await stripeChangePlanInPlace(req.user!.id, planId);
        if (change) {
          return res.json({
            success: true,
            data: {
              url: null,
              effective: change.effective,
              effectiveAt: change.effectiveAt,
            },
          });
        }
      }

      const session =
        provider === "stripe"
          ? await createStripePlanCheckoutSession({
              userId: req.user!.id,
              email,
              planId,
            })
          : await createPaystackPlanCheckoutSession({
              userId: req.user!.id,
              email,
              planId,
            });
      return res.json({ success: true, data: { url: session.url } });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : "Could not start checkout",
      });
    }
  })
);

// POST /api/billing/portal — Stripe Customer Portal or Paystack manage link
router.post(
  "/portal",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const preferred =
      req.body?.provider === "stripe" || req.body?.provider === "paystack"
        ? (req.body.provider as BillingProvider)
        : null;
    const provider =
      (await resolveBillingProviderForPortal(req.user!.id)) ||
      (await resolveBillingProvider({
        userId: req.user!.id,
        preferred,
        userMetadata: userMetadataFrom(req),
        clientHint: clientHintFrom(req),
      }));
    if (!provider) {
      return res.status(503).json({
        success: false,
        message: billingNotConfiguredMessage(),
      });
    }
    const email = req.user?.email;
    if (!email) {
      return res.status(400).json({ success: false, message: "Account email is required" });
    }

    try {
      const session =
        provider === "stripe"
          ? await createStripeBillingPortalSession({ userId: req.user!.id, email })
          : await createPaystackBillingPortalSession({ userId: req.user!.id, email });
      return res.json({ success: true, data: { url: session.url } });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : "Could not open billing portal",
      });
    }
  })
);

// POST /api/billing/credits-addon — one-time credit pack checkout
router.post(
  "/credits-addon",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const preferred =
      req.body?.provider === "stripe" || req.body?.provider === "paystack"
        ? (req.body.provider as BillingProvider)
        : null;
    const provider = await resolveBillingProvider({
      userId: req.user!.id,
      preferred,
      userMetadata: userMetadataFrom(req),
      clientHint: clientHintFrom(req),
    });
    if (!provider) {
      return res.status(503).json({
        success: false,
        message: billingNotConfiguredMessage(),
      });
    }
    const email = req.user?.email;
    if (!email) {
      return res.status(400).json({ success: false, message: "Account email is required" });
    }

    try {
      const session =
        provider === "stripe"
          ? await createStripeCreditsAddonCheckoutSession({ userId: req.user!.id, email })
          : await createPaystackCreditsAddonCheckoutSession({ userId: req.user!.id, email });
      return res.json({ success: true, data: { url: session.url } });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : "Could not start add-on checkout",
      });
    }
  })
);

// POST /api/billing/verify — confirm Stripe session_id or Paystack reference after redirect
router.post(
  "/verify",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const sessionId =
      typeof req.body?.sessionId === "string"
        ? req.body.sessionId.trim()
        : typeof req.body?.session_id === "string"
          ? req.body.session_id.trim()
          : "";
    const reference = typeof req.body?.reference === "string" ? req.body.reference.trim() : "";

    if (!sessionId && !reference) {
      return res.status(400).json({ success: false, message: "sessionId or reference is required" });
    }

    try {
      if (sessionId) {
        const result = await verifyStripeCheckoutSession(sessionId);
        return res.json({ success: true, data: result });
      }
      const result = await verifyPaystackReference(reference);
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : "Could not verify payment",
      });
    }
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
    const id = String(req.params.id);
    const ok = await deletePaymentMethod(req.user!.id, id);
    if (!ok) return res.status(404).json({ success: false, message: "Payment method not found" });
    return res.json({ success: true, message: "Payment method removed" });
  })
);

// PATCH /api/billing/payment-methods/:id/primary
router.patch(
  "/payment-methods/:id/primary",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const id = String(req.params.id);
    const method = await setPrimaryPaymentMethod(req.user!.id, id);
    if (!method) return res.status(404).json({ success: false, message: "Payment method not found" });
    return res.json({ success: true, data: { paymentMethod: toPaymentMethod(method) } });
  })
);

// GET /api/billing/credits-usage?year=2026
router.get(
  "/credits-usage",
  authenticateToken,
  asyncHandler(async (req: AuthRequest, res) => {
    const year = Math.max(
      2020,
      Math.min(2100, parseInt(String(req.query.year ?? new Date().getUTCFullYear()), 10) || new Date().getUTCFullYear())
    );
    await ensureBillingAccount(req.user!.id);
    const months = await getMonthlyCreditUsage(req.user!.id, year);
    return res.json({ success: true, data: { year, months } });
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

import { Router } from "express";
import { supabaseAdmin } from "../config/supabase";
import { authenticateToken, type AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";

const router = Router();

type BillingAccountRow = {
  user_id: string;
  plan_name: string;
  plan_price: string;
  plan_cycle: string;
  renews_on: string | null;
  credits_used: number;
  credits_total: number;
  payment_brand: string | null;
  payment_last4: string | null;
  payment_expiry: string | null;
};

type InvoiceRow = {
  id: string;
  invoice_date: string;
  description: string;
  amount: string;
  status: "paid" | "pending" | "failed";
};

async function ensureBillingAccount(userId: string): Promise<BillingAccountRow> {
  const { data, error } = await supabaseAdmin
    .from("billing_accounts")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (data) return data as BillingAccountRow;

  const renewsOn = new Date();
  renewsOn.setDate(renewsOn.getDate() + 30);

  const { data: created, error: insertError } = await supabaseAdmin
    .from("billing_accounts")
    .upsert(
      {
        user_id: userId,
        renews_on: renewsOn.toISOString(),
      },
      { onConflict: "user_id" }
    )
    .select("*")
    .single();

  if (insertError || !created) {
    throw new Error(insertError?.message || "Failed to create billing account");
  }

  return created as BillingAccountRow;
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
      invoices: ((invoices as InvoiceRow[]) ?? []).map((invoice) => ({
        id: invoice.id,
        date: invoice.invoice_date,
        description: invoice.description,
        amount: invoice.amount,
        status: invoice.status,
      })),
    };

    return res.json({ success: true, data: { billing } });
  })
);

export default router;

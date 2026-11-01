import { supabaseAdmin } from "../config/supabase";
import {
  calendarDaysUntil,
  ensureBillingAccount,
  formatPlanDate,
  type BillingAccountRow,
  type PlanTierId,
} from "./billing";
import { createNotification } from "./notifications";

/** Days before renews_on when we warn the customer. */
const REMINDER_DAYS = [7, 3, 1] as const;

type ReminderDay = (typeof REMINDER_DAYS)[number];

function reminderTitle(days: ReminderDay): string {
  if (days === 1) return "Subscription renews tomorrow";
  return `Subscription renewing in ${days} days`;
}

function reminderDescription(planName: string, renewsOn: string, days: ReminderDay): string {
  const when = formatPlanDate(renewsOn) ?? "soon";
  if (days === 1) {
    return `Your ${planName} plan renews tomorrow (${when}). Keep a payment method on file so access is not interrupted.`;
  }
  return `Your ${planName} plan renews in ${days} days (${when}). Add or confirm a payment method so Convert Tide can renew without interruption.`;
}

async function alreadyNotified(userId: string, title: string, sinceIso: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("title", title)
    .gte("created_at", sinceIso);

  if (error) {
    console.warn("[subscription-lifecycle] notify dedupe:", error.message);
    return false;
  }
  return (count ?? 0) > 0;
}

async function sendRenewalReminder(account: BillingAccountRow, days: ReminderDay): Promise<boolean> {
  if (!account.renews_on) return false;
  const title = reminderTitle(days);
  // One reminder per milestone per billing period (window = renews_on − days − 1 day slack).
  const windowStart = new Date(account.renews_on);
  windowStart.setUTCDate(windowStart.getUTCDate() - days - 1);
  if (await alreadyNotified(account.user_id, title, windowStart.toISOString())) {
    return false;
  }

  await createNotification(account.user_id, {
    category: "billing",
    title,
    description: reminderDescription(account.plan_name, account.renews_on, days),
    actionLabel: "View Billing",
    actionHref: "/dashboard/billing",
    actionTone: "warning",
  });
  return true;
}

/**
 * Scans paid accounts: sends 7 / 3 / 1 day renewal reminders, and forces expiry
 * catch-up via ensureBillingAccount (covers missed webhooks and orphaned grants).
 */
export async function runSubscriptionLifecycleSweep(): Promise<{
  scanned: number;
  reminded: number;
  expired: number;
}> {
  const { data, error } = await supabaseAdmin
    .from("billing_accounts")
    .select("*")
    .neq("plan_id", "free");

  if (error) {
    console.error("[subscription-lifecycle] scan failed:", error.message);
    return { scanned: 0, reminded: 0, expired: 0 };
  }

  const rows = (data as BillingAccountRow[]) ?? [];
  let reminded = 0;
  let expired = 0;

  for (const row of rows) {
    try {
      const planId = row.plan_id as PlanTierId;
      if (planId === "free") continue;

      const days = calendarDaysUntil(row.renews_on);
      if (days !== null && (REMINDER_DAYS as readonly number[]).includes(days)) {
        const sent = await sendRenewalReminder(row, days as ReminderDay);
        if (sent) reminded += 1;
      }

      // ensureBillingAccount lapses expired paid plans (no provider / cancel_at_period_end)
      // and emits the "Subscription expired" notification when it does.
      const after = await ensureBillingAccount(row.user_id);
      if (after.plan_id === "free" && row.plan_id !== "free") {
        expired += 1;
      }
    } catch (err) {
      console.error(
        "[subscription-lifecycle] account failed",
        row.user_id,
        err instanceof Error ? err.message : err
      );
    }
  }

  return { scanned: rows.length, reminded, expired };
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Starts the hourly lifecycle sweep (and one immediate run after boot). */
export function startSubscriptionLifecycleScheduler(): void {
  const run = () => {
    void runSubscriptionLifecycleSweep()
      .then((result) => {
        if (result.reminded || result.expired) {
          console.log(
            `[subscription-lifecycle] scanned=${result.scanned} reminded=${result.reminded} expired=${result.expired}`
          );
        }
      })
      .catch((err) => {
        console.error("[subscription-lifecycle] sweep error", err);
      });
  };

  // Slight delay so the HTTP server is listening before the first DB sweep.
  setTimeout(run, 15_000);
  setInterval(run, SWEEP_INTERVAL_MS);
}

import type { BillingProvider } from "./billingProvider";

/**
 * Drops the subscription held at the processor the account just moved away from, so a
 * user who switches between Stripe and Paystack is never billed by both.
 *
 * Call this only once the new subscription is live — cancelling earlier would strand a
 * user who abandons checkout on no plan at all.
 *
 * The provider services are imported lazily on purpose: they import this module, and a
 * static cycle would leave one of them half-initialised at require time.
 */
export async function cancelOtherProviderSubscription(
  userId: string,
  keep: BillingProvider
): Promise<void> {
  const other =
    keep === "stripe"
      ? import("./paystack").then((m) => m.cancelSubscriptionImmediately(userId))
      : import("./stripe").then((m) => m.cancelSubscriptionImmediately(userId));

  try {
    const cancelled = await other;
    if (cancelled) {
      console.info(
        `[billing] cancelled superseded ${keep === "stripe" ? "paystack" : "stripe"} subscription for ${userId}`
      );
    }
  } catch (err) {
    console.warn("[billing] cancelOtherProviderSubscription:", err instanceof Error ? err.message : err);
  }
}

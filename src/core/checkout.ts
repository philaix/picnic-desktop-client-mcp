import PicnicClient from "picnic-api";
import { getClient } from "./client.js";
import { markCartChanged } from "./session.js";
import * as shop from "./shop.js";

// Ordering follows the app: start the checkout for the cart as it is, start the payment, let the
// user approve it on the payment page (PayPal, card, bank), then poll until Picnic reports it done.

/** Where the payment page sends the browser afterwards; the app learns the result by polling. */
const PAYMENT_RETURN_URL = "https://picnic.app/de/";

export type OrderSummary = {
  /** Whether the order can be placed as it is. */
  ready: boolean;
  /** What stops the order, in plain words. */
  problems: string[];
  itemCount: number;
  total: number;
  minimumOrderValue: number | null;
  slot: { start: string | null; end: string | null } | null;
  paymentMethod: string | null;
  /** Products Picnic can't deliver; they are left out of the order. */
  unavailable: string[];
  /** The cart's state; placing the order only works while the cart is unchanged. */
  confirmation: string;
};

export type CheckoutIssue = { title: string; message: string; resolveKey: string; blocking: boolean; type: string };

export type PlaceOrderResult =
  | { status: "issue"; issue: CheckoutIssue }
  | { status: "payment"; orderId: string; transactionId: string; paymentUrl: string | null; total: number; expiresAt: string };

async function paymentMethod(client: PicnicClient): Promise<string | null> {
  try {
    const profile = await client.payment.getPaymentProfile();
    const stored = profile.stored_payment_options ?? [];
    const preferred = stored.find((option) => option.id === profile.preferred_payment_option_id) ?? stored[0];
    return preferred?.display_name ?? null;
  } catch {
    return null;
  }
}

export async function orderSummary(): Promise<OrderSummary> {
  const client = getClient();
  const [cart, method] = await Promise.all([shop.cart(), paymentMethod(client)]);
  const problems: string[] = [];
  if (cart.items.length === 0) problems.push("Der Warenkorb ist leer.");
  if (!cart.slot?.start) problems.push("Es ist kein Lieferfenster gewählt.");
  if (cart.minimumOrderValue && cart.total < cart.minimumOrderValue) {
    problems.push(`Der Mindestbestellwert von ${(cart.minimumOrderValue / 100).toFixed(2).replace(".", ",")} € ist noch nicht erreicht.`);
  }
  return {
    ready: problems.length === 0,
    problems,
    itemCount: cart.totalCount,
    total: cart.total,
    minimumOrderValue: cart.minimumOrderValue,
    slot: cart.slot ? { start: cart.slot.start, end: cart.slot.end } : null,
    paymentMethod: method,
    unavailable: cart.items.filter((item) => item.unavailable).map((item) => item.name),
    confirmation: String(cart.version),
  };
}

/**
 * Starts the checkout and the payment for the cart the summary showed. Returns a checkout issue
 * (e.g. an age check) for the user to accept, or the payment page to open.
 */
export async function placeOrder(confirmation: string, resolveKey?: string): Promise<PlaceOrderResult> {
  const client = getClient();
  const summary = await orderSummary();
  if (summary.confirmation !== String(confirmation)) {
    throw new Error("Der Warenkorb hat sich seit der Zusammenfassung geändert. Bitte die Bestellung noch einmal prüfen.");
  }
  if (!summary.ready) throw new Error(summary.problems.join(" "));

  // The summary listed these as not deliverable, so the user accepted leaving them out.
  const unavailableIds = (await client.cart.getCart()).items.filter((line) => line.isUnavailable).map((line) => line.productId);
  let checkout;
  try {
    checkout = await client.checkout.startCheckout({
      mts: Number(summary.confirmation),
      resolveKey,
      outOfStockArticleIds: unavailableIds.length ? unavailableIds : undefined,
    });
  } catch (error) {
    if (PicnicClient.isCheckoutIssueError(error)) {
      return {
        status: "issue",
        issue: { title: error.title, message: error.issueMessage, resolveKey: error.resolveKey, blocking: error.blocking, type: error.issueType },
      };
    }
    throw error;
  }
  const payment = await client.checkout.initiatePayment(checkout.order_id, PAYMENT_RETURN_URL);
  return {
    status: "payment",
    orderId: checkout.order_id,
    transactionId: payment.transaction_id,
    paymentUrl: payment.action?.redirect_url ?? payment.issuer_authentication_url ?? null,
    total: checkout.total_price,
    expiresAt: checkout.transaction_expiry,
  };
}

export type OrderState = { state: "placed" | "waiting" | "failed"; detail: string };

export async function orderStatus(transactionId: string): Promise<OrderState> {
  const { checkout_status: status } = await getClient().checkout.getCheckoutStatus(transactionId);
  if (status === "FINISHED") {
    markCartChanged();
    return { state: "placed", detail: status };
  }
  if (/FAIL|CANCEL|EXPIRE|ERROR|REJECT/i.test(status)) return { state: "failed", detail: status };
  return { state: "waiting", detail: status };
}

export async function cancelPayment(transactionId: string): Promise<void> {
  await getClient().checkout.cancelCheckout(transactionId);
}

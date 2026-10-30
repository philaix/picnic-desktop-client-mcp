import PicnicClient from "picnic-api";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getClient } from "./client.js";
import { dataDir, markCartChanged } from "./session.js";
import * as shop from "./shop.js";

/**
 * Keeps Picnic's full answer to a failed checkout step in checkout-error.json, so a refusal can be
 * understood afterwards (the app only shows a short message).
 */
async function logged<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    try {
      mkdirSync(dataDir(), { recursive: true });
      writeFileSync(
        join(dataDir(), "checkout-error.json"),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            step,
            status: PicnicClient.isPicnicApiError(error) ? error.status : null,
            code: PicnicClient.isPicnicApiError(error) ? error.code : null,
            body: PicnicClient.isPicnicApiError(error) ? error.body : String(error),
          },
          null,
          2,
        ),
      );
    } catch {
      // The log is only a diagnosis aid.
    }
    throw error;
  }
}

// Ordering follows the app: confirm the slot, start the checkout for the cart as it is, start the
// payment, then poll the order until Picnic reports it done. A stored payment method (PayPal, SEPA)
// pays right away; only a method that needs the user's approval (e.g. 3-D Secure) returns a page.

/** The app's own return link; Picnic denies the payment (PAYMENT_REQUEST_DENIED) for web URLs. */
const PAYMENT_RETURN_URL = "nl.picnic-supermarkt://payment";

const nonEmpty = (value: string | null | undefined) => (value && value.trim() ? value : null);

export type OrderSummary = {
  /** Whether the order can be placed as it is. */
  ready: boolean;
  /** What stops the order, in plain words. */
  problems: string[];
  itemCount: number;
  total: number;
  minimumOrderValue: number | null;
  /** `suggested`: Picnic proposed the slot; placing the order confirms it. */
  slot: { start: string | null; end: string | null; suggested: boolean } | null;
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

/** Shown when Picnic has no default payment method; it then denies the payment (PAYMENT_REQUEST_DENIED). */
export const NO_DEFAULT_PAYMENT =
  "Picnic kennt für dein Konto gerade keine Standard-Zahlungsart. Öffne in der Picnic-App einmal die Kasse, wähle dort deine Zahlungsart aus und brich dann ab. Danach klappt das Bestellen hier.";

/** The payment method Picnic will charge: the preferred stored option. `null` name when unknown. */
async function paymentMethod(client: PicnicClient): Promise<{ name: string | null; hasDefault: boolean | null }> {
  try {
    const profile = await client.payment.getPaymentProfile();
    const preferred = (profile.stored_payment_options ?? []).find((option) => option.id === profile.preferred_payment_option_id);
    return { name: preferred?.display_name ?? null, hasDefault: !!preferred };
  } catch {
    // Unknown: let Picnic decide at checkout instead of blocking the order.
    return { name: null, hasDefault: null };
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
  if (method.hasDefault === false) problems.push(NO_DEFAULT_PAYMENT);
  return {
    ready: problems.length === 0,
    problems,
    itemCount: cart.totalCount,
    total: cart.total,
    minimumOrderValue: cart.minimumOrderValue,
    slot: cart.slot ? { start: cart.slot.start, end: cart.slot.end, suggested: !cart.slot.chosenByUser } : null,
    paymentMethod: method.name,
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

  const cart = await client.cart.getCart();
  let mts = cart.mts;
  // Picnic only checks out a slot the user picked (CART_CONFIRM_SLOT); confirm the suggested one the summary showed.
  if (cart.selectedSlot && !cart.selectedSlot.isExplicitSelection) {
    const slotId = cart.selectedSlot.slotId;
    mts = (await logged("set_delivery_slot", () => client.cart.setDeliverySlot(slotId))).mts;
    markCartChanged();
  }
  // The summary listed these as not deliverable, so the user accepted leaving them out.
  const unavailableIds = cart.items.filter((line) => line.isUnavailable).map((line) => line.productId);
  let checkout;
  try {
    checkout = await logged("checkout_start", () =>
      client.checkout.startCheckout({
        mts,
        resolveKey,
        outOfStockArticleIds: unavailableIds.length ? unavailableIds : undefined,
      }),
    );
  } catch (error) {
    if (PicnicClient.isCheckoutIssueError(error)) {
      return {
        status: "issue",
        issue: { title: error.title, message: error.issueMessage, resolveKey: error.resolveKey, blocking: error.blocking, type: error.issueType },
      };
    }
    throw error;
  }
  const orderId = checkout.order_id;
  const payment = await logged("initiate_payment", () => client.checkout.initiatePayment(orderId, PAYMENT_RETURN_URL));
  return {
    status: "payment",
    orderId: checkout.order_id,
    transactionId: payment.transaction_id,
    paymentUrl: nonEmpty(payment.issuer_authentication_url) ?? nonEmpty(payment.action?.redirect_url),
    total: checkout.total_price,
    expiresAt: checkout.transaction_expiry,
  };
}

export type OrderState = { state: "placed" | "waiting" | "failed"; detail: string };

const isFailed = (status: string) => /FAIL|CANCEL|EXPIRE|ERROR|REJECT|DENIED/i.test(status);

/** Orders this process already confirmed, so polling never confirms twice. */
const confirmedOrders = new Set<string>();

/**
 * Where an order stands. A payment that went through on its own (direct debit) finishes the order;
 * a payment the user approved on a page (PayPal) only finishes the transaction, and the order then
 * still has to be confirmed, as Picnic's own clients do (`confirmOrder`).
 */
export async function orderStatus(orderId: string, transactionId?: string): Promise<OrderState> {
  const client = getClient();
  const order = await client.checkout.getOrderStatus(orderId);
  if (order.checkout_status === "FINISHED") {
    markCartChanged();
    return { state: "placed", detail: order.checkout_status };
  }
  if (isFailed(order.checkout_status)) return { state: "failed", detail: order.checkout_status };
  if (!transactionId) return { state: "waiting", detail: order.checkout_status };

  let payment: string;
  try {
    payment = (await client.checkout.getCheckoutStatus(transactionId)).checkout_status;
  } catch {
    // Some accounts don't answer by transaction id; the order status above covers them.
    return { state: "waiting", detail: order.checkout_status };
  }
  if (isFailed(payment)) return { state: "failed", detail: payment };
  if (payment !== "FINISHED") return { state: "waiting", detail: payment };
  if (!confirmedOrders.has(orderId)) {
    await logged("confirm_order", () => client.checkout.confirmOrder(orderId));
    confirmedOrders.add(orderId);
  }
  markCartChanged();
  return { state: "placed", detail: "CONFIRMED" };
}

export async function cancelPayment(transactionId: string): Promise<void> {
  await getClient().checkout.cancelCheckout(transactionId);
}

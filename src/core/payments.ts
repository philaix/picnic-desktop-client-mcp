import { getClient } from "./client.js";

// Read-only view of the account's payment setup. Managing payment methods happens in a native
// screen of Picnic's app (app.picnic://payments/wallet/payment-methods) whose calls aren't known.

const METHOD_NAMES: Record<string, string> = {
  PAYPAL: "PayPal",
  DIRECT_DEBIT: "Lastschrift",
  SEPA_DIRECT_DEBIT: "Lastschrift",
  CARD: "Kreditkarte",
  IDEAL: "iDEAL",
  BANCONTACT: "Bancontact",
};
const TYPE_NAMES: Record<string, string> = { PAYMENT: "Zahlung", REFUND: "Erstattung" };
const STATUS_NAMES: Record<string, string> = {
  PAID: "bezahlt",
  PENDING: "offen",
  OPEN: "offen",
  FAILED: "fehlgeschlagen",
  REFUNDED: "erstattet",
  CANCELLED: "storniert",
};

const label = (names: Record<string, string>, value: string | null | undefined) =>
  value ? (names[value.toUpperCase()] ?? value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, " ")) : null;

export type PaymentOption = { id: string; name: string; method: string | null; account: string | null; icon: string | null; isDefault: boolean };
export type PaymentRecord = {
  id: string;
  date: string;
  type: string | null;
  method: string | null;
  amount: number;
  status: string | null;
  failed: boolean;
};

export async function paymentOverview(limit = 20) {
  const client = getClient();
  const [profile, transactions] = await Promise.all([
    client.payment.getPaymentProfile(),
    client.payment.getWalletTransactions(1).catch(() => []),
  ]);
  const options: PaymentOption[] = (profile.stored_payment_options ?? []).map((option) => ({
    id: option.id,
    name: option.display_name || label(METHOD_NAMES, option.payment_method) || "Zahlungsart",
    method: label(METHOD_NAMES, option.payment_method),
    // Picnic sends accounts masked, e.g. "•••• 2173".
    account: option.account || null,
    icon: option.icon_url || null,
    isDefault: option.id === profile.preferred_payment_option_id,
  }));
  const records: PaymentRecord[] = transactions.slice(0, limit).map((t) => ({
    id: t.id,
    date: new Date(t.timestamp).toISOString(),
    type: label(TYPE_NAMES, t.transaction_type),
    method: label(METHOD_NAMES, t.transaction_method),
    amount: t.amount_in_cents,
    status: label(STATUS_NAMES, t.status),
    failed: /FAIL|CANCEL/i.test(t.status ?? ""),
  }));
  return {
    defaultOption: options.find((option) => option.isDefault) ?? null,
    options,
    /** Methods Picnic offers to add in its app, e.g. "Kreditkarte". */
    canAdd: (profile.payment_methods ?? []).filter((m) => m.visibility === "SHOWN").map((m) => m.display_name),
    records,
  };
}

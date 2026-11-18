const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VARIANT = /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/;

type Line = {
  variantId: string;
  quantity: number;
  unitPriceCHF: number;
  title: string;
};

type Cart = {
  items: Line[];
  subtotalCHF: number;
  currency: "CHF";
};

export type DraftPayloadInput = {
  requestId: string;
  checkoutReference: string;
  storedItems: unknown;
  freshCart: Cart;
  verifiedSubtotalCHF: string;
  deliveryFeeCHF: string;
};

function cents(value: unknown): number {
  if (typeof value !== "number" ||
      !Number.isFinite(value) || value < 0)
    throw new Error("INVALID_MONEY");

  const result = Math.round(value * 100);
  if (!Number.isSafeInteger(result) ||
      Math.abs(value * 100 - result) > 0.000001)
    throw new Error("INVALID_MONEY");

  return result;
}

function dbCents(value: string): number {
  if (typeof value !== "string" ||
      !/^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/.test(value))
    throw new Error("INVALID_DB_MONEY");

  const [whole, fraction] = value.split(".");
  return Number(whole) * 100 + Number(fraction);
}

export function buildAloNowDraftOrderPayload(input: DraftPayloadInput) {
  if (!UUID.test(input.requestId) ||
      !UUID.test(input.checkoutReference))
    throw new Error("INVALID_CHECKOUT_IDENTITY");

  if (input.freshCart.currency !== "CHF")
    throw new Error("CURRENCY_MISMATCH");

  const stored = input.storedItems;
  const fresh = input.freshCart.items;

  if (!Array.isArray(stored) || !Array.isArray(fresh) ||
      fresh.length < 1 || fresh.length > 15 ||
      stored.length !== fresh.length)
    throw new Error("INVALID_CART_LINES");

  const storedById = new Map<string, Line>();

  for (const raw of stored) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("INVALID_STORED_LINE");

    const line = raw as Line;

    if (typeof line.variantId !== "string" ||
        !VARIANT.test(line.variantId) ||
        !Number.isInteger(line.quantity) ||
        line.quantity < 1 || line.quantity > 30 ||
        typeof line.title !== "string" ||
        !line.title.trim() ||
        storedById.has(line.variantId))
      throw new Error("INVALID_STORED_LINE");

    if (cents(line.unitPriceCHF) < 1)
      throw new Error("INVALID_STORED_PRICE");

    storedById.set(line.variantId, line);
  }

  let subtotal = 0;
  const seen = new Set<string>();

  const lines = fresh.map(line => {
    const old = storedById.get(line.variantId);

    if (!VARIANT.test(line.variantId) ||
        seen.has(line.variantId) ||
        !Number.isInteger(line.quantity) ||
        line.quantity < 1 || line.quantity > 30 ||
        !old || old.quantity !== line.quantity ||
        cents(old.unitPriceCHF) !== cents(line.unitPriceCHF))
      throw new Error("CART_OR_PRICE_CHANGED");

    const unit = cents(line.unitPriceCHF);
    if (unit < 1) throw new Error("INVALID_FRESH_PRICE");

    seen.add(line.variantId);
    subtotal += unit * line.quantity;

    if (!Number.isSafeInteger(subtotal) || subtotal > 100000000)
      throw new Error("CART_TOTAL_LIMIT");

    return { variantId: line.variantId, quantity: line.quantity };
  });

  if (subtotal !== cents(input.freshCart.subtotalCHF) ||
      subtotal !== dbCents(input.verifiedSubtotalCHF))
    throw new Error("SUBTOTAL_MISMATCH");

  const fee = dbCents(input.deliveryFeeCHF);
  if (fee > 10000000) throw new Error("DELIVERY_FEE_LIMIT");

  const total = subtotal + fee;

  return {
    expectedTotalCHF: (total / 100).toFixed(2),
    draftInput: {
      presentmentCurrencyCode: "CHF" as const,
      lineItems: lines,
      shippingLine: {
        title: "ALO NOW Lieferung",
        priceWithCurrency: {
          amount: (fee / 100).toFixed(2),
          currencyCode: "CHF" as const
        }
      },
      customAttributes: [
        { key: "alo_now_request_id", value: input.requestId },
        { key: "alo_now_checkout_reference", value: input.checkoutReference }
      ],
      tags: ["ALO_NOW"]
    }
  };
}

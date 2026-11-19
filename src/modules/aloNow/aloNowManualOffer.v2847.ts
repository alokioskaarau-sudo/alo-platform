// ALO_NOW_V2847_MANUAL_OFFER_PRICING
// Pure calculation only. No database mutation or checkout release.

export const ALO_NOW_MANUAL_DEFAULT_DELIVERY_CHF = "12.90";

export type AloNowManualOfferInputV2847 = {
  verifiedSubtotalCHF: string;
  deliveryFeeCHF: string;
  extraFeeCHF: string;
  extraReason?: string | null;
};

export type AloNowManualOfferV2847 = {
  currency: "CHF";
  verifiedSubtotalCHF: string;
  deliveryFeeCHF: string;
  extraFeeCHF: string;
  extraReason: string | null;
  totalCHF: string;
};

function parseCHF(value: string): number {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,7})\.[0-9]{2}$/.test(value)
  ) {
    throw new Error("INVALID_CHF_AMOUNT");
  }

  const [francs, rappen] = value.split(".");
  const result = Number(francs) * 100 + Number(rappen);

  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("INVALID_CHF_AMOUNT");
  }

  return result;
}

function formatCHF(rappen: number): string {
  if (!Number.isSafeInteger(rappen) || rappen < 0) {
    throw new Error("INVALID_CHF_TOTAL");
  }

  return (rappen / 100).toFixed(2);
}

export function calculateAloNowManualOfferV2847(
  input: AloNowManualOfferInputV2847
): AloNowManualOfferV2847 {
  const subtotal = parseCHF(input.verifiedSubtotalCHF);
  const delivery = parseCHF(input.deliveryFeeCHF);
  const extra = parseCHF(input.extraFeeCHF);

  if (subtotal < 1 || subtotal > 100000000) {
    throw new Error("SUBTOTAL_OUT_OF_RANGE");
  }

  // ALO_NOW_V2865B_SERVER_SAFETY
  if (delivery < 1290) {
    throw new Error("DELIVERY_FEE_BELOW_MINIMUM");
  }

  if (delivery > 100000 || extra > 100000) {
    throw new Error("FEE_OUT_OF_RANGE");
  }

  const reason = (input.extraReason ?? "").trim();

  if (reason.length > 250) {
    throw new Error("EXTRA_REASON_TOO_LONG");
  }

  if (extra > 0 && reason.length < 3) {
    throw new Error("EXTRA_REASON_REQUIRED");
  }

  const total = subtotal + delivery + extra;

  if (!Number.isSafeInteger(total)) {
    throw new Error("TOTAL_OVERFLOW");
  }

  return {
    currency: "CHF",
    verifiedSubtotalCHF: formatCHF(subtotal),
    deliveryFeeCHF: formatCHF(delivery),
    extraFeeCHF: formatCHF(extra),
    extraReason: extra > 0 ? reason : null,
    totalCHF: formatCHF(total)
  };
}


import type {
  ShopifyPaymentReader,
  ShopifyPaymentSnapshot
} from "./aloNowTrustedPaymentVerification.js";

export type ShopifyAdminGraphql = (
  query: string,
  variables: Record<string, unknown>
) => Promise<unknown>;

const ORDER_ID =
  /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;

const PAYMENT_QUERY = `
  query AloNowReadPaymentEvidence($id: ID!) {
    node(id: $id) {
      ... on Order {
        id
        displayFinancialStatus
        cancelledAt
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalRefundedSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalOutstandingSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
    }
  }
`;

function object(
  value: unknown
): Record<string, unknown> | null {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
}

/**
 * Accepts only a Shopify Admin GraphQL result.
 * The GraphQL transport must be authenticated server-side.
 *
 * No browser-provided snapshot may be passed as evidence.
 */
export function createAloNowShopifyAdminPaymentReader(
  graphql: ShopifyAdminGraphql
): ShopifyPaymentReader {
  return async (
    orderId: string
  ): Promise<ShopifyPaymentSnapshot | null> => {
    if (!ORDER_ID.test(orderId)) {
      throw new Error("INVALID_SHOPIFY_ORDER_ID");
    }

    const raw = object(await graphql(
      PAYMENT_QUERY,
      { id: orderId }
    ));

    if (!raw)
      throw new Error("SHOPIFY_RESPONSE_INVALID");

    // Support both the established GraphQL response
    // envelope and clients that unwrap the data field.
    if (
      Array.isArray(raw.errors) &&
      raw.errors.length > 0
    ) {
      throw new Error("SHOPIFY_GRAPHQL_ERROR");
    }

    const envelope = object(raw.data) ?? raw;
    const node = object(envelope.node);

    if (!node) return null;

    const moneySet = object(node.totalPriceSet);
    const money = object(moneySet?.shopMoney);

    if (
      typeof node.id !== "string" ||
      node.id !== orderId ||
      typeof node.displayFinancialStatus !== "string" ||
      !money ||
      typeof money.amount !== "string" ||
      typeof money.currencyCode !== "string" ||
      !(
        node.cancelledAt === null ||
        typeof node.cancelledAt === "string"
      )
    ) {
      throw new Error("SHOPIFY_EVIDENCE_INVALID");
    }

    // ALO_V295_CHF_NORMALIZATION
    // Shopify Money.amount may be "42", "42.5" or "42.50".
    // Normalize via integer cents, never floating-point rounding.
    const rawAmount = money.amount;

    if (
      !/^(0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(rawAmount)
    ) {
      throw new Error("SHOPIFY_AMOUNT_INVALID");
    }

    const [whole, fraction = ""] = rawAmount.split(".");
    const cents = Number(whole) * 100 +
      Number(fraction.padEnd(2, "0"));

    if (
      !Number.isSafeInteger(cents) ||
      cents < 0
    ) {
      throw new Error("SHOPIFY_AMOUNT_INVALID");
    }

    const normalizedAmount =
      String(Math.floor(cents / 100)) +
      "." +
      String(cents % 100).padStart(2, "0");

    // V869C: Separater CHF-Restbetrag, nur lesend.
    const outstandingSet = object(node.totalOutstandingSet);
    const outstandingMoney = object(outstandingSet?.shopMoney);

    if (
      !outstandingMoney ||
      typeof outstandingMoney.amount !== "string" ||
      outstandingMoney.currencyCode !== "CHF" ||
      money.currencyCode !== "CHF"
    ) {
      throw new Error("SHOPIFY_OUTSTANDING_INVALID");
    }

    const rawOutstanding=outstandingMoney.amount;

    if (
      !/^(0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(rawOutstanding)
    ) {
      throw new Error("SHOPIFY_OUTSTANDING_INVALID");
    }

    const [
      outstandingWhole,
      outstandingFraction=""
    ]=rawOutstanding.split(".");

    const outstandingCents=
      Number(outstandingWhole)*100+
      Number(outstandingFraction.padEnd(2,"0"));

    if (
      !Number.isSafeInteger(outstandingCents) ||
      outstandingCents<0
    ) {
      throw new Error("SHOPIFY_OUTSTANDING_INVALID");
    }

    const normalizedOutstanding=
      String(Math.floor(outstandingCents/100))+
      "."+
      String(outstandingCents%100).padStart(2,"0");


      // ALO_V1695C_REFUND_READER
      // Missing refunds must never silently become zero.
      const refundSet = object(node.totalRefundedSet);
      const refundMoney = object(refundSet?.shopMoney);

      if (
        !refundMoney ||
        refundMoney.currencyCode !== "CHF" ||
        typeof refundMoney.amount !== "string"
      ) {
        throw new Error("SHOPIFY_REFUND_EVIDENCE_INVALID");
      }

      const rawRefund = refundMoney.amount;

      if (
        !/^(0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(rawRefund)
      ) {
        throw new Error("SHOPIFY_REFUND_AMOUNT_INVALID");
      }

      const [refundWhole, refundFraction = ""] =
        rawRefund.split(".");

      const refundRappen =
        Number(refundWhole) * 100 +
        Number(refundFraction.padEnd(2, "0"));

      if (!Number.isSafeInteger(refundRappen)) {
        throw new Error("SHOPIFY_REFUND_AMOUNT_INVALID");
      }

      const normalizedRefund =
        String(Math.floor(refundRappen / 100)) +
        "." +
        String(refundRappen % 100).padStart(2, "0");

    return {
      id: node.id,
      displayFinancialStatus:
        node.displayFinancialStatus,
      cancelledAt: node.cancelledAt,
      totalPriceSet: {
        shopMoney: {
          amount: normalizedAmount,
          currencyCode: money.currencyCode
        }
      },
      totalOutstandingSet: {
        shopMoney: {
          amount: normalizedOutstanding,
          currencyCode: "CHF"
        }
      },
      totalRefundedSet: {
        shopMoney: {
          amount: normalizedRefund,
          currencyCode: "CHF"
        }
      }
    };
  };
}

import test from "node:test";
import assert from "node:assert/strict";

import {
  verifyOriginalQuoteV1651,
} from "./aloNowVerifiedQuoteBinding.v1651.js";

const orderId = "gid://shopify/Order/123";

function harness(options: {
  duplicate?: boolean;
  phase?: string;
  method?: string;
  requestMismatch?: boolean;
  quoteStatus?: string;
  verified?: boolean;
  subtotal?: string;
  fee?: string;
  total?: string;
  outstanding?: string;
  financial?: string;
  cancelled?: boolean;
  wrongOrder?: boolean;
  currency?: string;
} = {}) {
  let shopifyCalls = 0;

  const row = {
    order_id: orderId,
    payment_request_id:
      options.requestMismatch ? "request-2" : "request-1",
    request_id: "request-1",
    payment_method: options.method ?? "ONLINE",
    phase: options.phase ?? "PAYMENT_CONFIRMED",
    quote_status: options.quoteStatus ?? "STANDARD",
    verified_at: options.verified === false
      ? null : "2026-11-03T18:00:00Z",
    subtotal: options.subtotal ?? "29.50",
    fee: options.fee ?? "3.00",
  };

  const dependencies = {
    db: {
      async query(sql: string, params?: unknown[]) {
        assert.ok(sql.includes("JOIN alo_now_order_requests"));
        assert.ok(sql.includes("p.request_id"));
        assert.deepEqual(params, [orderId, "123"]);

        return {
          rows: options.duplicate ? [row, row] : [row],
          rowCount: options.duplicate ? 2 : 1,
        };
      },
    },

    async readShopifyPayment(id: string) {
      shopifyCalls++;
      assert.equal(id, orderId);

      return {
        id: options.wrongOrder
          ? "gid://shopify/Order/999" : orderId,
        cancelledAt: options.cancelled
          ? "2026-11-03T19:00:00Z" : null,
        displayFinancialStatus:
          options.financial ?? "PAID",
        totalPriceSet: {
          shopMoney: {
            amount: options.total ?? "32.50",
            currencyCode: options.currency ?? "CHF",
          },
        },
        totalOutstandingSet: {
          shopMoney: {
            amount: options.outstanding ?? "0.00",
            currencyCode: options.currency ?? "CHF",
          },
        },
      };
    },
  };

  return {
    dependencies,
    shopifyCalls: () => shopifyCalls,
  };
}

async function blocked(
  options: Parameters<typeof harness>[0],
  reason: RegExp
) {
  const h = harness(options);

  await assert.rejects(
    verifyOriginalQuoteV1651(orderId, h.dependencies),
    reason
  );

  return h;
}

test("Verifizierte Originalsumme stimmt exakt", async () => {
  const h = harness();
  const result = await verifyOriginalQuoteV1651(
    orderId, h.dependencies
  );

  assert.equal(
    result.status,
    "ORIGINAL_ONLINE_QUOTE_VERIFIED"
  );
  assert.equal(result.expectedTotalRappen, 3250);
  assert.equal(result.requestId, "request-1");
  assert.equal(h.shopifyCalls(), 1);
});

test("Nachträglich geänderte Summe blockiert", async () => {
  await blocked(
    {total: "27.50"},
    /ORIGINAL_QUOTE_TOTAL_MISMATCH/
  );
});

test("Doppelte Zahlungsbindung blockiert früh", async () => {
  const h = await blocked(
    {duplicate: true},
    /QUOTE_BINDING_NOT_UNIQUE/
  );
  assert.equal(h.shopifyCalls(), 0);
});

test("Falsche Request-Verknüpfung blockiert", async () => {
  await blocked(
    {requestMismatch: true},
    /QUOTE_REQUEST_ID_MISMATCH/
  );
});

test("Unbestätigte Zahlung blockiert", async () => {
  await blocked(
    {phase: "AWAITING_PAYMENT"},
    /ONLINE_PAYMENT_NOT_CONFIRMED/
  );
});

test("Fehlender Originalnachweis blockiert", async () => {
  await blocked(
    {verified: false},
    /VERIFIED_ORIGINAL_QUOTE_MISSING/
  );
});

test("Offener Shopify-Betrag blockiert", async () => {
  await blocked(
    {outstanding: "2.00"},
    /QUOTE_SHOPIFY_NOT_FULLY_PAID/
  );
});

test("Stornierte Shopify-Bestellung blockiert", async () => {
  await blocked(
    {cancelled: true},
    /QUOTE_SHOPIFY_ORDER_CANCELLED/
  );
});

test("Fremde Shopify-Bestellung blockiert", async () => {
  await blocked(
    {wrongOrder: true},
    /QUOTE_SHOPIFY_ORDER_MISMATCH/
  );
});

test("Falsche Währung blockiert", async () => {
  await blocked(
    {currency: "EUR"},
    /QUOTE_SHOPIFY_CURRENCY_OR_FIELDS_INVALID/
  );
});

test("CASH wird von diesem ONLINE-Guard blockiert", async () => {
  await blocked(
    {method: "CASH", phase: "CASH_CONFIRMED"},
    /ONLINE_PAYMENT_NOT_CONFIRMED/
  );
});

test("Manipulierte Dezimalwerte blockieren", async () => {
  await blocked(
    {subtotal: "29.999"},
    /INVALID_CHF_DECIMAL/
  );
});

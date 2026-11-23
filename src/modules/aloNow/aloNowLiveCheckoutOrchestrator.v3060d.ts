// ALO_NOW_V3060D_LIVE_ORCHESTRATOR
// One request -> one reserved external Shopify creation.
// No HTTP route or customer checkout authorization here.

import {randomUUID} from "node:crypto";
import {
  verifyAloNowShopifyCart
} from "./aloNowShopifyCartGuard.service.js";


import type {Pool} from "pg";

import {
  loadAloNowStoredCheckoutSnapshot
} from "./aloNowStoredCheckoutSnapshot.js";

import {
  reserveAloNowCheckoutAttempt,
  markAloNowCheckoutReady,
  markAloNowCheckoutUncertain
} from "./aloNowCheckoutPersistence.js";

import {
  createAloNowShopifyDraftLiveV3060C
} from "./aloNowShopifyLiveTransport.v3060c.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CheckoutResult =
  | {
      ok: true;
      status: "READY";
      draftOrderId: string;
    }
  | {
      ok: false;
      status: "BLOCKED" | "RECONCILE";
      reason: string;
    };

export async function createAloNowLiveCheckoutV3060D(
  pool: Pool,
  input: {
    requestId: string;
    shopDomain: string;
    accessToken: string;
  }
): Promise<CheckoutResult> {
  // Two independent switches. Neither defaults to enabled.
  if (
    process.env.ALO_NOW_LIVE_DRAFT_CHECKOUT_ENABLED !== "true" ||
    process.env.ALO_NOW_LIVE_CHECKOUT_ORCHESTRATOR_ENABLED !== "true"
  ) {
    return {
      ok: false,
      status: "BLOCKED",
      reason: "LIVE_CHECKOUT_DISABLED"
    };
  }

  if (!UUID.test(input.requestId)) {
    return {
      ok: false,
      status: "BLOCKED",
      reason: "INVALID_REQUEST_ID"
    };
  }

  const reference = randomUUID();

  let snapshot: Awaited<
    ReturnType<typeof loadAloNowStoredCheckoutSnapshot>
  >;

  // ALO_NOW_V3060H_PREFLIGHT_OUTSIDE_TRANSACTION
  // Shopify network I/O must never hold PostgreSQL row locks.
  let preflightSnapshot: Awaited<
    ReturnType<typeof loadAloNowStoredCheckoutSnapshot>
  >;

  const preliminary = await pool.connect();

  try {
    preflightSnapshot =
      await loadAloNowStoredCheckoutSnapshot(
        preliminary,
        input.requestId
      );
  } catch {
    return {
      ok: false,
      status: "BLOCKED",
      reason: "CHECKOUT_PREFLIGHT_NOT_READY"
    };
  } finally {
    preliminary.release();
  }

  try {
    const freshCart = await verifyAloNowShopifyCart(
      preflightSnapshot.lineItems
    );

    if (
      freshCart.currency !== "CHF" ||
      freshCart.items.length !==
        preflightSnapshot.lineItems.length ||
      freshCart.subtotalCHF.toFixed(2) !==
        preflightSnapshot.subtotalCHF
    ) {
      throw new Error("SHOPIFY_CART_CHANGED");
    }

    const byVariant = new Map(
      freshCart.items.map(item => [item.variantId, item])
    );

    for (const expected of preflightSnapshot.lineItems) {
      const actual = byVariant.get(expected.variantId);

      if (!actual || actual.quantity !== expected.quantity) {
        throw new Error("SHOPIFY_CART_IDENTITY_CHANGED");
      }
    }
  } catch {
    return {
      ok: false,
      status: "BLOCKED",
      reason: "SHOPIFY_CART_REVALIDATION_FAILED"
    };
  }

  // STEP 1: Commit the reservation before contacting Shopify.
  const first = await pool.connect();

  try {
    await first.query("BEGIN");

    await first.query(
      "SET LOCAL lock_timeout = '3s'"
    );

    await first.query(
      "SET LOCAL statement_timeout = '12s'"
    );

    const locked = await first.query(
      `SELECT r.id
       FROM public.alo_now_order_requests r
       JOIN public.alo_now_payment_states p
         ON p.request_id = r.id
       WHERE r.id = $1
       FOR UPDATE OF r, p`,
      [input.requestId]
    );

    if (locked.rowCount !== 1) {
      throw new Error("PAYMENT_STATE_NOT_READY");
    }

    snapshot = await loadAloNowStoredCheckoutSnapshot(
      first,
      input.requestId
    );

    // Reject stale requests before reserving a Shopify attempt.
    if (
      JSON.stringify(snapshot) !==
      JSON.stringify(preflightSnapshot)
    ) {
      throw new Error("CHECKOUT_SNAPSHOT_CHANGED");
    }

    const reserved = await reserveAloNowCheckoutAttempt(
      first,
      snapshot.requestId,
      reference,
      snapshot.expectedTotalCHF
    );

    if (!reserved) {
      throw new Error("CHECKOUT_ALREADY_RESERVED");
    }

    await first.query("COMMIT");
  } catch (error) {
    await first.query("ROLLBACK").catch(() => undefined);

    return {
      ok: false,
      status: "BLOCKED",
      reason: error instanceof Error
        ? error.message
        : "CHECKOUT_RESERVATION_FAILED"
    };
  } finally {
    first.release();
  }

  // STEP 2: Call Shopify exactly once.
  // Never retry automatically, including on timeout.
  const contact = snapshot.deliveryContact;

  const result = await createAloNowShopifyDraftLiveV3060C({
    shopDomain: input.shopDomain,
    accessToken: input.accessToken,
    expectedTotalCHF: snapshot.expectedTotalCHF,
    draftInput: {
      presentmentCurrencyCode: "CHF",
      lineItems: snapshot.lineItems,
      shippingLine: {
        title: "ALO NOW Lieferung",
        priceWithCurrency: {
          // ALO_NOW_V3078_SHIPPING_TOTAL
          amount: snapshot.deliveryFeeCHF,
          currencyCode: "CHF"
        }
      },
      customAttributes: [
        {
          key: "alo_now_request_id",
          value: snapshot.requestId
        },
        {
          key: "alo_now_checkout_reference",
          value: reference
        }
      ],
      tags: ["ALO_NOW", "ALO_NOW_DELIVERY"],
      email: contact.email,
      phone: contact.phone,
      shippingAddress: {
        firstName: contact.firstName,
        lastName: contact.lastName,
        address1: contact.address1,
        address2: contact.address2,
        zip: contact.zip,
        city: contact.city,
        countryCode: "CH"
      }
    }
  });

  // STEP 3: Persist Shopify's verified response.
  const second = await pool.connect();

  try {
    await second.query("BEGIN");

    if (result.ok) {
      const saved = await markAloNowCheckoutReady(
        second,
        snapshot.requestId,
        reference,
        result.draftOrderId,
        result.invoiceUrl,
        snapshot.expectedTotalCHF
      );

      if (!saved) {
        throw new Error("CHECKOUT_PERSISTENCE_CONFLICT");
      }

      await second.query("COMMIT");

      // Never return the invoice URL here.
      // A separate customer-token-protected route
      // must authorize access to the payment link.
      return {
        ok: true,
        status: "READY",
        draftOrderId: result.draftOrderId
      };
    }

    await markAloNowCheckoutUncertain(
      second,
      snapshot.requestId,
      reference
    );

    await second.query("COMMIT");

    return {
      ok: false,
      status: "RECONCILE",
      reason: result.reason
    };
  } catch {
    await second.query("ROLLBACK").catch(() => undefined);

    // External creation may already have succeeded.
    // Never automatically start another attempt.
    return {
      ok: false,
      status: "RECONCILE",
      reason: "SHOPIFY_RESULT_REQUIRES_RECONCILIATION"
    };
  } finally {
    second.release();
  }
}

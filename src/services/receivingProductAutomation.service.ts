import { db } from "../database/db.js";

import {
  verifyProductOnline,
} from "./productOnlineVerification.service.js";

import {
  createShopifyProductDraft,
  ShopifyProductDraftConflictError,
} from "./shopifyProductDraft.service.js";

function isPlainObject(
  value: unknown
): value is Record<string, any> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isMissing(
  value: unknown
): boolean {
  if (
    value === null ||
    value === undefined
  ) {
    return true;
  }

  if (
    typeof value === "string"
  ) {
    return value.trim() === "";
  }

  if (
    Array.isArray(value)
  ) {
    return value.length === 0;
  }

  return false;
}

/**
 * ALO Receiving darf bereits bekannte Werte niemals
 * durch die Web-Recherche überschreiben.
 *
 * Nur echte Lücken werden aus verifiedDraft ergänzt.
 */
function fillMissing(
  current: any,
  incoming: any
): any {
  if (
    !isPlainObject(current) ||
    !isPlainObject(incoming)
  ) {
    return isMissing(current)
      ? incoming
      : current;
  }

  const result: Record<
    string,
    any
  > = {
    ...current,
  };

  for (
    const [
      key,
      incomingValue,
    ] of Object.entries(
      incoming
    )
  ) {
    const currentValue =
      result[key];

    if (
      isPlainObject(
        incomingValue
      )
    ) {
      if (
        isPlainObject(
          currentValue
        )
      ) {
        result[key] =
          fillMissing(
            currentValue,
            incomingValue
          );
      } else if (
        isMissing(
          currentValue
        )
      ) {
        result[key] =
          incomingValue;
      }

      continue;
    }

    if (
      isMissing(
        currentValue
      ) &&
      !isMissing(
        incomingValue
      )
    ) {
      result[key] =
        incomingValue;
    }
  }

  return result;
}

export type ReceivingProductAutomationResult =
  | {
      status:
        "READY_FOR_REVIEW";
      identityStatus:
        "confirmed";
      productId: string;
      enriched: true;
      shopify: {
        status:
          string | null;
        shopifyProductId:
          string | null;
        shopifyVariantId:
          string | null;
        shopifyInventoryItemId:
          string | null;
        linkedExisting:
          boolean;
        alreadyExists:
          boolean;
        imageUploaded:
          boolean;
      };
    }
  | {
      status:
        "REVIEW_REQUIRED";
      identityStatus:
        | "probable"
        | "not_confirmed";
      productId: string;
      enriched: false;
      reason:
        "IDENTITY_NOT_CONFIRMED";
    }
  | {
      status:
        "SHOPIFY_CONFLICT";
      identityStatus:
        "confirmed";
      productId: string;
      enriched: true;
      reason: string;
      error: string;
    };

export async function automateReceivingProduct(
  productId: string
): Promise<
  ReceivingProductAutomationResult
> {
  const productResult =
    await db.query(
      `
        SELECT
          id,
          barcode,
          title,
          product_data,
          review_status
        FROM products
        WHERE id = $1
        LIMIT 1
      `,
      [productId]
    );

  const product =
    productResult.rows[0];

  if (!product) {
    throw new Error(
      "Receiving Product Master wurde nicht gefunden."
    );
  }

  const currentDraft =
    product.product_data &&
    typeof product.product_data ===
      "object"
      ? product.product_data
      : {};

  const verification =
    await verifyProductOnline({
      draft:
        currentDraft,
      barcode:
        product.barcode ??
        currentDraft?.barcode ??
        null,
    });

  if (
    verification.identityStatus !==
    "confirmed"
  ) {
    return {
      status:
        "REVIEW_REQUIRED",
      identityStatus:
        verification.identityStatus,
      productId:
        String(product.id),
      enriched: false,
      reason:
        "IDENTITY_NOT_CONFIRMED",
    };
  }

  const mergedDraft =
    fillMissing(
      currentDraft,
      verification.verifiedDraft ??
        {}
    );

  /**
   * WICHTIG:
   * review_status wird hier absichtlich NICHT
   * verändert.
   *
   * Ein AI-verifiziertes Produkt ist weiterhin
   * NEEDS_REVIEW bis ein Mitarbeiter es freigibt.
   */
  await db.query(
    `
      UPDATE products
      SET
        product_data = $2::jsonb,
        updated_at = NOW()
      WHERE id = $1
    `,
    [
      productId,
      JSON.stringify(
        mergedDraft
      ),
    ]
  );

  try {
    const shopify =
      await createShopifyProductDraft(
        productId
      );

    return {
      status:
        "READY_FOR_REVIEW",
      identityStatus:
        "confirmed",
      productId:
        String(product.id),
      enriched: true,
      shopify: {
        status:
          shopify.status ??
          null,
        shopifyProductId:
          shopify.shopifyProductId ??
          null,
        shopifyVariantId:
          shopify.shopifyVariantId ??
          null,
        shopifyInventoryItemId:
          shopify.shopifyInventoryItemId ??
          null,
        linkedExisting:
          Boolean(
            shopify.linkedExisting
          ),
        alreadyExists:
          Boolean(
            shopify.alreadyExists
          ),
        imageUploaded:
          Boolean(
            shopify.imageUploaded
          ),
      },
    };
  } catch (error) {
    if (
      error instanceof
      ShopifyProductDraftConflictError
    ) {
      return {
        status:
          "SHOPIFY_CONFLICT",
        identityStatus:
          "confirmed",
        productId:
          String(product.id),
        enriched: true,
        reason:
          error.reason,
        error:
          error.message,
      };
    }

    throw error;
  }
}

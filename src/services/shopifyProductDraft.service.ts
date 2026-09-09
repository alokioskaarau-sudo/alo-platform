import axios from "axios";

import { db } from "../database/db.js";
import { env } from "../config/env.js";

import {
  getShopifyAccessToken,
} from "../integrations/shopify/auth.js";

import {
  resolveProductIdentity,
} from "./productIdentity.service.js";

function normalizeBarcode(
  value: unknown
): string {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeShop(
  value: string
): string {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(
      /\.myshopify\.com$/,
      ""
    );
}

async function shopifyGraphql(
  query: string,
  variables: Record<
    string,
    unknown
  >
) {
  const token =
    await getShopifyAccessToken();

  const shop =
    normalizeShop(
      env.shopify.shop
    );

  const response =
    await axios.post(
      `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
      {
        query,
        variables,
      },
      {
        headers: {
          "Content-Type":
            "application/json",
          "X-Shopify-Access-Token":
            token,
        },
        timeout: 30000,
      }
    );

  if (
    response.data?.errors?.length
  ) {
    throw new Error(
      response.data.errors
        .map(
          (error: any) =>
            error.message
        )
        .join(" · ")
    );
  }

  return response.data?.data;
}

async function getProduct(
  id: string
) {
  const result =
    await db.query(
      `
        SELECT
          id,
          barcode,
          title,
          product_data,
          source_type,
          review_status,
          shopify_status,
          shopify_product_id,
          shopify_variant_id,
          shopify_inventory_item_id,
          updated_at
        FROM products
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

  return result.rows[0] ?? null;
}

function aloText(
  value: unknown
) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value).trim();
}

function aloJoin(
  values: unknown[],
  separator = " / "
) {
  return values
    .map(aloText)
    .filter(Boolean)
    .join(separator);
}

function buildShopifyProductMetafields(
  draft: any
) {
  const nutrition =
    draft?.nutritionPer100 ?? {};

  const allergens =
    Array.isArray(
      draft?.allergens
    )
      ? draft.allergens
          .map(aloText)
          .filter(Boolean)
      : [];

  const traces =
    Array.isArray(
      draft?.traces
    )
      ? draft.traces
          .map(aloText)
          .filter(Boolean)
      : [];

  let allergenText =
    allergens.join(", ");

  if (traces.length) {
    allergenText +=
      `${allergenText ? "\n" : ""}Kann Spuren enthalten: ${traces.join(", ")}`;
  }

  const energy =
    aloJoin([
      nutrition.energyKj,
      nutrition.energyKcal,
    ]);

  const pointsRaw =
    Number(
      draft?.commerce
        ?.pointsMultiplier ??
      draft?.pointsMultiplier ??
      1
    );

  const pointsMultiplier =
    Number.isFinite(pointsRaw) &&
    pointsRaw >= 1
      ? Math.round(pointsRaw)
      : 1;

  const metafields = [
    {
      namespace: "custom",
      key: "herkunft",
      type:
        "single_line_text_field",
      value:
        aloText(draft?.country),
    },
    {
      namespace: "custom",
      key: "inhalt",
      type:
        "single_line_text_field",
      value:
        aloText(
          draft?.unitSize
        ) ||
        aloText(
          draft?.netWeight
        ),
    },
    {
      namespace: "custom",
      key: "geschmack",
      type:
        "single_line_text_field",
      value:
        aloText(draft?.flavor),
    },
    {
      namespace: "custom",
      key: "energie",
      type:
        "single_line_text_field",
      value: energy,
    },
    {
      namespace: "custom",
      key: "fett",
      type:
        "single_line_text_field",
      value:
        aloText(
          nutrition.fat
        ),
    },
    {
      namespace: "custom",
      key:
        "gesaettigte_fettsaeuren",
      type:
        "single_line_text_field",
      value:
        aloText(
          nutrition.saturatedFat
        ),
    },
    {
      namespace: "custom",
      key: "kohlenhydrate",
      type:
        "single_line_text_field",
      value:
        aloText(
          nutrition.carbohydrates
        ),
    },
    {
      namespace: "custom",
      key: "zucker",
      type:
        "single_line_text_field",
      value:
        aloText(
          nutrition.sugars
        ),
    },
    {
      namespace: "custom",
      key: "eiweiss",
      type:
        "single_line_text_field",
      value:
        aloText(
          nutrition.protein
        ),
    },
    {
      namespace: "custom",
      key: "salz",
      type:
        "single_line_text_field",
      value:
        aloText(
          nutrition.salt
        ),
    },
    {
      namespace: "custom",
      key: "nahrungsfasern",
      type:
        "single_line_text_field",
      value:
        aloText(
          nutrition.fiber
        ) ||
        aloText(
          nutrition.fibre
        ),
    },
    {
      namespace: "custom",
      key: "zutaten",
      type:
        "multi_line_text_field",
      value:
        aloText(
          draft?.ingredients
        ),
    },
    {
      namespace: "custom",
      key: "allergene",
      type:
        "multi_line_text_field",
      value: allergenText,
    },
    {
      namespace: "custom",
      key:
        "servierempfehlung",
      type:
        "multi_line_text_field",
      value:
        aloText(
          draft
            ?.servingRecommendation
        ),
    },
    {
      namespace: "custom",
      key: "typ",
      type:
        "single_line_text_field",
      value:
        aloText(
          draft?.productType
        ) ||
        aloText(
          draft?.category
        ),
    },
    {
      namespace: "rewards",
      key:
        "points_multiplier",
      type: "number_integer",
      value:
        String(
          pointsMultiplier
        ),
    },
  ];

  return metafields.filter(
    (field) =>
      field.namespace ===
        "rewards" ||
      field.value.trim().length >
        0
  );
}

async function stageProductImage(
  productId: string
): Promise<
  | {
      source: string;
      alt: string;
    }
  | null
> {
  const imageResult =
    await db.query(
      `
        SELECT
          image_data,
          mime_type,
          original_name
        FROM product_images
        WHERE product_id = $1
        ORDER BY
          is_primary DESC,
          created_at DESC
        LIMIT 1
      `,
      [productId]
    );

  const image =
    imageResult.rows[0];

  if (!image) {
    return null;
  }

  const mime =
    String(
      image.mime_type ||
        "image/jpeg"
    );

  const extension =
    mime.includes("png")
      ? "png"
      : mime.includes("webp")
        ? "webp"
        : "jpg";

  const filename =
    image.original_name ||
    `alo-product-${productId}.${extension}`;

  const staged =
    await shopifyGraphql(
      `
        mutation AloStageProductImage(
          $input:
            [StagedUploadInput!]!
        ) {
          stagedUploadsCreate(
            input: $input
          ) {
            stagedTargets {
              url
              resourceUrl
              parameters {
                name
                value
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        input: [
          {
            resource:
              "PRODUCT_IMAGE",
            filename,
            mimeType: mime,
            httpMethod: "POST",
          },
        ],
      }
    );

  const payload =
    staged?.stagedUploadsCreate;

  if (
    payload?.userErrors?.length
  ) {
    throw new Error(
      payload.userErrors
        .map(
          (error: any) =>
            error.message
        )
        .join(" · ")
    );
  }

  const target =
    payload
      ?.stagedTargets?.[0];

  if (
    !target?.url ||
    !target?.resourceUrl
  ) {
    throw new Error(
      "Shopify Bild-Upload-Ziel fehlt."
    );
  }

  const form =
    new FormData();

  for (
    const parameter of
      target.parameters ?? []
  ) {
    form.append(
      parameter.name,
      parameter.value
    );
  }

  const bytes =
    new Uint8Array(
      image.image_data
    );

  form.append(
    "file",
    new Blob(
      [bytes],
      {
        type: mime,
      }
    ),
    filename
  );

  const uploadResponse =
    await fetch(
      target.url,
      {
        method: "POST",
        body: form,
      }
    );

  if (!uploadResponse.ok) {
    throw new Error(
      `Shopify Bild-Upload fehlgeschlagen (${uploadResponse.status}).`
    );
  }

  return {
    source:
      target.resourceUrl,
    alt: filename,
  };
}

export class ShopifyProductDraftConflictError
  extends Error {
  reason: string;
  details: any;

  constructor(
    reason: string,
    message: string,
    details: any = null
  ) {
    super(message);

    this.name =
      "ShopifyProductDraftConflictError";

    this.reason = reason;
    this.details = details;
  }
}

export async function createShopifyProductDraft(
  productId: string
) {
  const row =
    await getProduct(
      productId
    );

  if (!row) {
    throw new Error(
      "Produkt nicht gefunden."
    );
  }

  if (
    row.shopify_product_id
  ) {
    return {
      ok: true as const,
      alreadyExists: true,
      linkedExisting: false,
      shopifyProductId:
        row.shopify_product_id,
      shopifyVariantId:
        row.shopify_variant_id,
      shopifyInventoryItemId:
        row.shopify_inventory_item_id,
      status:
        row.shopify_status,
      imageUploaded: false,
    };
  }

  const draft =
    row.product_data ?? {};

  const identity =
    await resolveProductIdentity({
      barcode:
        row.barcode,
      title:
        draft?.title ??
        row.title,
      unitSize:
        draft?.unitSize,
      netWeight:
        draft?.netWeight,
    });

  if (
    identity.status ===
    "MULTIPLE_BARCODE_MATCHES"
  ) {
    throw new ShopifyProductDraftConflictError(
      "MULTIPLE_SHOPIFY_BARCODE_MATCHES",
      `EAN ${identity.barcode} existiert mehrfach in Shopify. Manuelle Prüfung erforderlich.`,
      {
        barcode:
          identity.barcode,
        matches:
          identity.matches.map(
            (match) => ({
              shopifyProductId:
                match.productId,
              shopifyVariantId:
                match.variantId,
              shopifyInventoryItemId:
                match.inventoryItemId,
              title:
                match.productTitle,
              status:
                match.productStatus,
            })
          ),
      }
    );
  }

  if (
    identity.status ===
    "MULTIPLE_IDENTITY_MATCHES"
  ) {
    throw new ShopifyProductDraftConflictError(
      "MULTIPLE_SHOPIFY_IDENTITY_MATCHES",
      "Mehrere passende Shopify-Produkte gefunden. Manuelle Prüfung erforderlich.",
      {
        barcode:
          identity.barcode,
        sourceTitle:
          identity.sourceTitle,
        matches:
          identity.matches.map(
            (match) => ({
              shopifyProductId:
                match.productId,
              shopifyVariantId:
                match.variantId,
              shopifyInventoryItemId:
                match.inventoryItemId,
              title:
                match.productTitle,
              status:
                match.productStatus,
              barcode:
                match.barcode,
              size:
                match.size,
            })
          ),
      }
    );
  }

  if (
    identity.status ===
      "EXACT_BARCODE" ||
    identity.status ===
      "EXACT_TITLE_SIZE"
  ) {
    const match =
      identity.match;

    await db.query(
      `
        UPDATE products
        SET
          shopify_status = $2,
          shopify_product_id = $3,
          shopify_variant_id = $4,
          shopify_inventory_item_id = $5,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        productId,
        match.productStatus ||
          "LINKED",
        match.productId,
        match.variantId,
        match.inventoryItemId,
      ]
    );

    return {
      ok: true as const,
      alreadyExists: true,
      linkedExisting: true,
      matchedBy:
        identity.status ===
        "EXACT_BARCODE"
          ? "BARCODE"
          : "TITLE_SIZE",
      sourceTitle:
        draft?.title ??
        row.title,
      shopifyTitle:
        match.productTitle,
      shopifyProductId:
        match.productId,
      shopifyVariantId:
        match.variantId,
      shopifyInventoryItemId:
        match.inventoryItemId,
      status:
        match.productStatus ||
        "LINKED",
      barcode:
        match.barcode,
      size:
        match.size,
      imageUploaded: false,
    };
  }

  const productInput: any = {
    title:
      String(
        row.title
      ).toUpperCase(),
    status: "DRAFT",
  };

  if (
    draft.descriptionHtml
  ) {
    productInput.descriptionHtml =
      draft.descriptionHtml;
  }

  if (draft.vendor) {
    productInput.vendor =
      draft.vendor;
  } else if (draft.brand) {
    productInput.vendor =
      draft.brand;
  }

  if (
    draft.productType
  ) {
    productInput.productType =
      draft.productType;
  } else if (
    draft.category
  ) {
    productInput.productType =
      draft.category;
  }

  if (
    Array.isArray(
      draft.tags
    )
  ) {
    productInput.tags =
      draft.tags;
  }

  if (
    draft.seoTitle ||
    draft.seoDescription
  ) {
    productInput.seo = {};

    if (draft.seoTitle) {
      productInput.seo.title =
        draft.seoTitle;
    }

    if (
      draft.seoDescription
    ) {
      productInput.seo.description =
        draft.seoDescription;
    }
  }

  const productMetafields =
    buildShopifyProductMetafields(
      draft
    );

  if (
    productMetafields.length
  ) {
    productInput.metafields =
      productMetafields;
  }

  const stagedImage =
    await stageProductImage(
      productId
    );

  const media =
    stagedImage
      ? [
          {
            originalSource:
              stagedImage.source,
            alt:
              draft.title ||
              row.title,
            mediaContentType:
              "IMAGE",
          },
        ]
      : [];

  const created =
    await shopifyGraphql(
      `
        mutation AloCreateProduct(
          $product:
            ProductCreateInput!,
          $media:
            [CreateMediaInput!]
        ) {
          productCreate(
            product: $product,
            media: $media
          ) {
            product {
              id
              title
              status
              variants(first: 1) {
                nodes {
                  id
                  inventoryItem {
                    id
                  }
                }
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        product:
          productInput,
        media,
      }
    );

  const payload =
    created?.productCreate;

  if (
    payload?.userErrors
      ?.length
  ) {
    throw new Error(
      payload.userErrors
        .map(
          (error: any) =>
            error.message
        )
        .join(" · ")
    );
  }

  const product =
    payload?.product;

  if (!product?.id) {
    throw new Error(
      "Shopify Produkt-ID fehlt."
    );
  }

  const variant =
    product.variants
      ?.nodes?.[0];

  let finalInventoryItemId =
    variant?.inventoryItem
      ?.id ?? null;

  if (variant?.id) {
    const variantInput: any = {
      id: variant.id,
    };

    const barcode =
      normalizeBarcode(
        row.barcode
      );

    if (barcode) {
      variantInput.barcode =
        barcode;
    }

    const possiblePrice =
      Number(
        draft?.commerce
          ?.sellingPrice ??
        draft?.sellingPrice ??
        NaN
      );

    if (
      Number.isFinite(
        possiblePrice
      ) &&
      possiblePrice > 0
    ) {
      variantInput.price =
        possiblePrice.toFixed(
          2
        );
    }

    const variantUpdate =
      await shopifyGraphql(
        `
          mutation AloUpdateVariant(
            $productId: ID!,
            $variants:
              [ProductVariantsBulkInput!]!
          ) {
            productVariantsBulkUpdate(
              productId:
                $productId,
              variants:
                $variants
            ) {
              productVariants {
                id
                barcode
                price
                inventoryItem {
                  id
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          productId:
            product.id,
          variants: [
            variantInput,
          ],
        }
      );

    const updatePayload =
      variantUpdate
        ?.productVariantsBulkUpdate;

    const errors =
      updatePayload
        ?.userErrors;

    if (errors?.length) {
      throw new Error(
        errors
          .map(
            (error: any) =>
              error.message
          )
          .join(" · ")
      );
    }

    finalInventoryItemId =
      updatePayload
        ?.productVariants?.[0]
        ?.inventoryItem?.id ??
      finalInventoryItemId;
  }

  await db.query(
    `
      UPDATE products
      SET
        shopify_status =
          'DRAFT',
        shopify_product_id =
          $2,
        shopify_variant_id =
          $3,
        shopify_inventory_item_id =
          $4,
        updated_at =
          NOW()
      WHERE id = $1
    `,
    [
      productId,
      product.id,
      variant?.id ?? null,
      finalInventoryItemId,
    ]
  );

  return {
    ok: true as const,
    alreadyExists: false,
    linkedExisting: false,
    shopifyProductId:
      product.id,
    shopifyVariantId:
      variant?.id ?? null,
    shopifyInventoryItemId:
      finalInventoryItemId,
    status: "DRAFT",
    imageUploaded:
      Boolean(
        stagedImage
      ),
  };
}

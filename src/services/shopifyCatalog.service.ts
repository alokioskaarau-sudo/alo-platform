import axios from "axios";

import { db } from "../database/db.js";
import { env } from "../config/env.js";
import { getShopifyAccessToken } from "../integrations/shopify/auth.js";
import {
  extractProductSize,
  normalizeProductBarcode,
  normalizeProductIdentityText,
  stripProductSize,
} from "./productIdentity.service.js";

type ShopifyVariant = {
  id: string;
  title: string | null;
  barcode: string | null;
  price: string | null;
  inventoryItemId: string | null;
};

type ShopifyCatalogProduct = {
  id: string;
  title: string;
  status: string | null;
  vendor: string | null;
  productType: string | null;
  handle: string | null;
  imageUrl: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  metafields: Record<string, string>;
  variants: ShopifyVariant[];
  variantsTruncated: boolean;
};

type ProductMasterRow = {
  id: string;
  barcode: string | null;
  title: string;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  shopify_inventory_item_id: string | null;
  shopify_status: string | null;
  product_data: any;
};

export type CatalogClassification =
  | "LINKED"
  | "MATCH"
  | "IMPORT"
  | "REVIEW";

function normalizeShop(value: string): string {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.myshopify\.com$/, "");
}

async function shopifyGraphql(
  query: string,
  variables: Record<string, unknown>
) {
  const token = await getShopifyAccessToken();
  const shop = normalizeShop(env.shopify.shop);

  const response = await axios.post(
    `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
    {
      query,
      variables,
    },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      timeout: 30000,
    }
  );

  if (response.data?.errors?.length) {
    throw new Error(
      response.data.errors
        .map((error: any) => error.message)
        .join(" · ")
    );
  }

  return response.data?.data;
}

async function loadShopifyCatalog(): Promise<
  ShopifyCatalogProduct[]
> {
  const products: ShopifyCatalogProduct[] = [];
  let after: string | null = null;

  do {
    const data = await shopifyGraphql(
      `
        query AloCatalogPreview($after: String) {
          products(first: 100, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              title
              status
              vendor
              productType
              handle
              seo {
                title
                description
              }
              featuredMedia {
                preview {
                  image {
                    url
                  }
                }
              }

              metafields(
                first: 50
                namespace: "custom"
              ) {
                nodes {
                  namespace
                  key
                  value
                }
              }

              variants(first: 100) {
                nodes {
                  id
                  title
                  barcode
                  price
                  inventoryItem {
                    id
                  }
                }
                pageInfo {
                  hasNextPage
                }
              }
            }
          }
        }
      `,
      { after }
    );

    const connection = data?.products;
    const nodes = Array.isArray(connection?.nodes)
      ? connection.nodes
      : [];

    for (const node of nodes) {
      const variants = Array.isArray(
        node?.variants?.nodes
      )
        ? node.variants.nodes.map((variant: any) => ({
            id: String(variant.id),
            title: variant.title
              ? String(variant.title)
              : null,
            barcode:
              normalizeProductBarcode(
                variant.barcode
              ) || null,
            price:
              variant.price !== undefined &&
              variant.price !== null
                ? String(variant.price)
                : null,
            inventoryItemId:
              variant.inventoryItem?.id
                ? String(
                    variant.inventoryItem.id
                  )
                : null,
          }))
        : [];

      products.push({
        id: String(node.id),
        title: String(node.title || ""),
        status: node.status
          ? String(node.status)
          : null,
        vendor: node.vendor
          ? String(node.vendor)
          : null,
        productType: node.productType
          ? String(node.productType)
          : null,
        handle: node.handle
          ? String(node.handle)
          : null,
        imageUrl:
          node.featuredMedia?.preview?.image?.url
            ? String(
                node.featuredMedia.preview.image.url
              )
            : null,

        seoTitle:
          node.seo?.title
            ? String(node.seo.title).trim() || null
            : null,

        seoDescription:
          node.seo?.description
            ? String(node.seo.description).trim() || null
            : null,

        metafields:
          Object.fromEntries(
            (
              Array.isArray(
                node?.metafields?.nodes
              )
                ? node.metafields.nodes
                : []
            )
              .filter(
                (field: any) =>
                  field?.key &&
                  field?.value !== undefined &&
                  field?.value !== null
              )
              .map(
                (field: any) => [
                  String(field.key),
                  String(field.value),
                ]
              )
          ),

        variants,
        variantsTruncated: Boolean(
          node?.variants?.pageInfo?.hasNextPage
        ),
      });
    }

    after =
      connection?.pageInfo?.hasNextPage
        ? connection.pageInfo.endCursor
        : null;
  } while (after);

  return products;
}

async function loadProductMaster(): Promise<
  ProductMasterRow[]
> {
  const result = await db.query(`
    SELECT
      id,
      barcode,
      title,
      shopify_product_id,
      shopify_variant_id,
      shopify_inventory_item_id,
      shopify_status,
      product_data
    FROM products
    ORDER BY id
  `);

  return result.rows.map((row: any) => ({
    ...row,
    id: String(row.id),
  }));
}

function shopifyText(
  product: ShopifyCatalogProduct,
  key: string
): string | null {
  const value =
    product.metafields?.[key];

  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  const text =
    String(value).trim();

  return text || null;
}

function splitAllergens(
  value: string | null
) {
  if (!value) {
    return {
      allergens: [] as string[],
      traces: [] as string[],
    };
  }

  const marker =
    /kann\s+spuren\s+enthalten\s*:/i;

  const parts =
    value.split(marker);

  const toList = (text: string) =>
    text
      .split(/[,;\n]/)
      .map((item) => item.trim())
      .filter(Boolean);

  return {
    allergens:
      toList(parts[0] ?? ""),
    traces:
      toList(parts.slice(1).join(" ")),
  };
}

function parseEnergy(
  value: string | null
) {
  if (!value) {
    return {
      energyKj: null,
      energyKcal: null,
    };
  }

  const kj =
    value.match(
      /(\d+(?:[.,]\d+)?)\s*kJ/i
    );

  const kcal =
    value.match(
      /(\d+(?:[.,]\d+)?)\s*kcal/i
    );

  return {
    energyKj:
      kj ? `${kj[1]} kJ` : null,
    energyKcal:
      kcal ? `${kcal[1]} kcal` : null,
  };
}

function buildShopifyFoodData(
  product: ShopifyCatalogProduct
) {
  const allergenData =
    splitAllergens(
      shopifyText(
        product,
        "allergene"
      )
    );

  const energy =
    parseEnergy(
      shopifyText(
        product,
        "energie"
      )
    );

  return {
    country:
      shopifyText(
        product,
        "herkunft"
      ),

    unitSize:
      shopifyText(
        product,
        "inhalt"
      ),

    flavor:
      shopifyText(
        product,
        "geschmack"
      ),

    ingredients:
      shopifyText(
        product,
        "zutaten"
      ),

    allergens:
      allergenData.allergens,

    traces:
      allergenData.traces,

    servingRecommendation:
      shopifyText(
        product,
        "servierempfehlung"
      ),

    nutritionPer100: {
      basis: "100 g/ml",

      energyKj:
        energy.energyKj,

      energyKcal:
        energy.energyKcal,

      fat:
        shopifyText(
          product,
          "fett"
        ),

      saturatedFat:
        shopifyText(
          product,
          "gesaettigte_fettsaeuren"
        ),

      carbohydrates:
        shopifyText(
          product,
          "kohlenhydrate"
        ),

      sugars:
        shopifyText(
          product,
          "zucker"
        ),

      protein:
        shopifyText(
          product,
          "eiweiss"
        ),

      fiber:
        shopifyText(
          product,
          "nahrungsfasern"
        ),

      salt:
        shopifyText(
          product,
          "salz"
        ),
    },
  };
}

function masterSize(row: ProductMasterRow) {
  return extractProductSize(
    row.product_data?.unitSize,
    row.product_data?.netWeight,
    row.title
  );
}

function titleSizeMatches(
  shopifyTitle: string,
  master: ProductMasterRow
) {
  const shopifySize =
    extractProductSize(shopifyTitle);
  const localSize = masterSize(master);

  if (!shopifySize || !localSize) {
    return false;
  }

  return (
    stripProductSize(shopifyTitle) ===
      stripProductSize(master.title) &&
    shopifySize === localSize
  );
}

export async function buildShopifyCatalogPreview() {
  const [shopifyProducts, productMaster] =
    await Promise.all([
      loadShopifyCatalog(),
      loadProductMaster(),
    ]);

  const byShopifyProductId = new Map<
    string,
    ProductMasterRow[]
  >();

  const byBarcode = new Map<
    string,
    ProductMasterRow[]
  >();

  for (const master of productMaster) {
    if (master.shopify_product_id) {
      const current =
        byShopifyProductId.get(
          master.shopify_product_id
        ) ?? [];

      current.push(master);

      byShopifyProductId.set(
        master.shopify_product_id,
        current
      );
    }

    const barcode =
      normalizeProductBarcode(
        master.barcode
      );

    if (barcode) {
      const current =
        byBarcode.get(barcode) ?? [];

      current.push(master);

      byBarcode.set(
        barcode,
        current
      );
    }
  }

  const items = shopifyProducts.map(
    (shopifyProduct) => {
      const linked =
        byShopifyProductId.get(
          shopifyProduct.id
        ) ?? [];

      if (linked.length === 1) {
        return {
          classification:
            "LINKED" as CatalogClassification,
          reason:
            "SHOPIFY_PRODUCT_ID_LINKED",
          shopify: shopifyProduct,
          productMaster: {
            id: linked[0].id,
            barcode: linked[0].barcode,
            title: linked[0].title,
            shopifyStatus:
              linked[0].shopify_status,
          },
        };
      }

      if (linked.length > 1) {
        return {
          classification:
            "REVIEW" as CatalogClassification,
          reason:
            "MULTIPLE_PRODUCT_MASTER_LINKS",
          shopify: shopifyProduct,
          candidates: linked.map(
            (row) => ({
              id: row.id,
              barcode: row.barcode,
              title: row.title,
            })
          ),
        };
      }

      if (
        shopifyProduct.variantsTruncated
      ) {
        return {
          classification:
            "REVIEW" as CatalogClassification,
          reason:
            "MORE_THAN_100_VARIANTS",
          shopify: shopifyProduct,
        };
      }

      if (
        shopifyProduct.variants.length !== 1
      ) {
        return {
          classification:
            "REVIEW" as CatalogClassification,
          reason:
            "MULTI_VARIANT_PRODUCT",
          shopify: shopifyProduct,
        };
      }

      const variant =
        shopifyProduct.variants[0];

      if (!variant.barcode) {
        const titleCandidates =
          productMaster.filter((master) =>
            titleSizeMatches(
              shopifyProduct.title,
              master
            )
          );

        if (titleCandidates.length) {
          return {
            classification:
              "REVIEW" as CatalogClassification,
            reason:
              titleCandidates.length === 1
                ? "BARCODE_MISSING_WITH_TITLE_SIZE_CANDIDATE"
                : "BARCODE_MISSING_WITH_MULTIPLE_TITLE_SIZE_CANDIDATES",
            shopify: shopifyProduct,
            warnings: [
              "BARCODE_MISSING",
            ],
            candidates:
              titleCandidates.map(
                (row) => ({
                  id: row.id,
                  barcode: row.barcode,
                  title: row.title,
                })
              ),
          };
        }

        return {
          classification:
            "IMPORT" as CatalogClassification,
          reason:
            "SHOPIFY_ONLY_BARCODE_MISSING",
          shopify: shopifyProduct,
          warnings: [
            "BARCODE_MISSING",
          ],
        };
      }

      const barcodeCandidates =
        byBarcode.get(
          variant.barcode
        ) ?? [];

      if (
        barcodeCandidates.length === 1
      ) {
        const match =
          barcodeCandidates[0];

        return {
          classification:
            "MATCH" as CatalogClassification,
          reason: "EXACT_BARCODE",
          shopify: shopifyProduct,
          productMaster: {
            id: match.id,
            barcode: match.barcode,
            title: match.title,
            shopifyStatus:
              match.shopify_status,
          },
        };
      }

      if (
        barcodeCandidates.length > 1
      ) {
        return {
          classification:
            "REVIEW" as CatalogClassification,
          reason:
            "MULTIPLE_BARCODE_MATCHES",
          shopify: shopifyProduct,
          candidates:
            barcodeCandidates.map(
              (row) => ({
                id: row.id,
                barcode: row.barcode,
                title: row.title,
              })
            ),
        };
      }

      const normalizedTitle =
        normalizeProductIdentityText(
          shopifyProduct.title
        );

      return {
        classification:
          "IMPORT" as CatalogClassification,
        reason:
          "SHOPIFY_ONLY_PRODUCT",
        shopify: shopifyProduct,
        normalizedTitle,
      };
    }
  );

  const summary = {
    shopifyProducts:
      shopifyProducts.length,
    productMasterProducts:
      productMaster.length,
    linked: items.filter(
      (item) =>
        item.classification ===
        "LINKED"
    ).length,
    matches: items.filter(
      (item) =>
        item.classification ===
        "MATCH"
    ).length,
    imports: items.filter(
      (item) =>
        item.classification ===
        "IMPORT"
    ).length,
    review: items.filter(
      (item) =>
        item.classification ===
        "REVIEW"
    ).length,
  };

  return {
    summary,
    items,
  };
}


function nonEmptyText(
  value: unknown
): string | null {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const text = String(value).trim();

  return text || null;
}

function mergeShopifyProductData(
  existingData: any,
  shopifyProduct: ShopifyCatalogProduct,
  variant: ShopifyVariant
) {
  const existing =
    existingData &&
    typeof existingData === "object"
      ? existingData
      : {};

  const food =
    buildShopifyFoodData(shopifyProduct);

  const next: any = {
    ...existing,
  };

  const normalizedTitle =
    String(shopifyProduct.title ?? "")
      .trim()
      .toUpperCase();

  if (normalizedTitle) {
    next.title = normalizedTitle;
  }

  const vendor =
    nonEmptyText(shopifyProduct.vendor);

  if (vendor) {
    next.vendor = vendor;
  }

  const productType =
    nonEmptyText(
      shopifyProduct.productType
    );

  if (productType) {
    next.productType = productType;
  }

  const seoTitle =
    nonEmptyText(
      shopifyProduct.seoTitle
    );

  if (seoTitle) {
    next.seoTitle = seoTitle;
  }

  const seoDescription =
    nonEmptyText(
      shopifyProduct.seoDescription
    );

  if (seoDescription) {
    next.seoDescription =
      seoDescription;
  }

  const country =
    nonEmptyText(food.country);

  if (country) {
    next.country = country;
  }

  const unitSize =
    nonEmptyText(food.unitSize) ??
    nonEmptyText(
      extractProductSize(
        shopifyProduct.title
      )
    );

  if (unitSize) {
    next.unitSize = unitSize;
  }

  const flavor =
    nonEmptyText(food.flavor);

  if (flavor) {
    next.flavor = flavor;
  }

  const ingredients =
    nonEmptyText(food.ingredients);

  if (ingredients) {
    next.ingredients = ingredients;
  }

  const servingRecommendation =
    nonEmptyText(
      food.servingRecommendation
    );

  if (servingRecommendation) {
    next.servingRecommendation =
      servingRecommendation;
  }

  const shopifyAllergens =
    nonEmptyText(
      shopifyProduct.metafields?.[
        "allergene"
      ]
    );

  if (shopifyAllergens) {
    next.allergens =
      food.allergens;

    next.traces =
      food.traces;
  }

  const existingNutrition =
    existing.nutritionPer100 &&
    typeof existing.nutritionPer100 ===
      "object"
      ? existing.nutritionPer100
      : {};

  const nextNutrition: any = {
    ...existingNutrition,
  };

  let nutritionChanged = false;

  const nutritionKeys = [
    "energyKj",
    "energyKcal",
    "fat",
    "saturatedFat",
    "carbohydrates",
    "sugars",
    "protein",
    "fiber",
    "salt",
  ] as const;

  for (const key of nutritionKeys) {
    const value =
      nonEmptyText(
        food.nutritionPer100?.[key]
      );

    if (value) {
      nextNutrition[key] = value;
      nutritionChanged = true;
    }
  }

  if (nutritionChanged) {
    if (
      !nonEmptyText(
        nextNutrition.basis
      )
    ) {
      nextNutrition.basis =
        "100 g/ml";
    }

    next.nutritionPer100 =
      nextNutrition;
  }

  const sellingPrice =
    nonEmptyText(variant.price);

  if (sellingPrice) {
    next.sellingPrice =
      sellingPrice;

    next.commerce = {
      ...(
        existing.commerce &&
        typeof existing.commerce ===
          "object"
          ? existing.commerce
          : {}
      ),
      sellingPrice,
    };
  }

  next.shopify = {
    ...(
      existing.shopify &&
      typeof existing.shopify ===
        "object"
        ? existing.shopify
        : {}
    ),

    productId:
      shopifyProduct.id,

    variantId:
      variant.id,

    inventoryItemId:
      variant.inventoryItemId,

    handle:
      shopifyProduct.handle,

    status:
      shopifyProduct.status,

    imageUrl:
      shopifyProduct.imageUrl,

    originalTitle:
      shopifyProduct.title,
  };

  return next;
}

function buildShopifyProductData(
  shopifyProduct: ShopifyCatalogProduct,
  variant: ShopifyVariant
) {
  return mergeShopifyProductData(
    {},
    shopifyProduct,
    variant
  );
}

async function importShopifyCatalogProductFromSnapshot(
  shopifyProduct: ShopifyCatalogProduct,
  productMaster: ProductMasterRow[]
) {
  const existingLinks =
    productMaster.filter(
      (product) =>
        product.shopify_product_id ===
        shopifyProduct.id
    );

  if (existingLinks.length > 1) {
    throw new Error(
      "Mehrere Product-Master-Produkte sind mit diesem Shopify-Produkt verknüpft."
    );
  }

  if (existingLinks.length === 1) {
    return {
      imported: false,
      alreadyLinked: true,
      linkedExisting: false,
      productMaster: existingLinks[0],
      shopifyProduct,
    };
  }

  if (
    shopifyProduct.variantsTruncated ||
    shopifyProduct.variants.length !== 1
  ) {
    throw new Error(
      "Produkt hat mehrere Varianten und benötigt manuelle Prüfung."
    );
  }

  const variant = shopifyProduct.variants[0];

  const barcode =
    normalizeProductBarcode(
      variant.barcode
    ) || null;

  if (barcode) {
    const barcodeMatches =
      productMaster.filter(
        (product) =>
          normalizeProductBarcode(
            product.barcode
          ) === barcode
      );

    if (barcodeMatches.length > 1) {
      throw new Error(
        `EAN ${barcode} existiert mehrfach im Product Master.`
      );
    }

    if (barcodeMatches.length === 1) {
      const existing =
        barcodeMatches[0];



      if (
        existing.shopify_product_id &&
        existing.shopify_product_id !== shopifyProduct.id
      ) {
        throw new Error(
          `Product Master ${existing.id} ist bereits mit einem anderen Shopify-Produkt verknüpft.`
        );
      }

      const result = await db.query(
        `
          UPDATE products
          SET
            shopify_status = $2,
            shopify_product_id = $3,
            shopify_variant_id = $4,
            shopify_inventory_item_id = $5,
            product_data =
              COALESCE(product_data, '{}'::jsonb)
              || jsonb_build_object(
                'shopify',
                jsonb_build_object(
                  'productId', $3::text,
                  'variantId', $4::text,
                  'inventoryItemId', $5::text,
                  'handle', $6::text,
                  'status', $2::text,
                  'imageUrl', $7::text,
                  'originalTitle', $8::text
                )
              ),
            updated_at = NOW()
          WHERE id = $1
          RETURNING
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
        `,
        [
          existing.id,
          shopifyProduct.status ??
            "LINKED",
          shopifyProduct.id,
          variant.id,
          variant.inventoryItemId,
          shopifyProduct.handle,
          shopifyProduct.imageUrl,
          shopifyProduct.title,
        ]
      );

      const updated =
        result.rows[0] as ProductMasterRow;

      return {
        imported: false,
        alreadyLinked: false,
        linkedExisting: true,
        matchedBy: "BARCODE",
        productMaster: updated,
        shopifyProduct,
      };
    }
  }

  const normalizedTitle =
    String(shopifyProduct.title ?? "")
      .trim()
      .toUpperCase();

  if (!normalizedTitle) {
    throw new Error(
      "Shopify-Produkt hat keinen gültigen Titel."
    );
  }

  if (!barcode) {
    const titleSizeCandidates =
      productMaster.filter(
        (product) =>
          titleSizeMatches(
            shopifyProduct.title,
            product
          )
      );

    if (titleSizeCandidates.length > 1) {
      throw new Error(
        "Produkt ohne EAN hat mehrere mögliche Product-Master-Treffer und benötigt manuelle Prüfung."
      );
    }

    if (titleSizeCandidates.length === 1) {
      const existing =
        titleSizeCandidates[0];



      if (
        existing.shopify_product_id &&
        existing.shopify_product_id !== shopifyProduct.id
      ) {
        throw new Error(
          `Product Master ${existing.id} ist bereits mit einem anderen Shopify-Produkt verknüpft.`
        );
      }

      const result = await db.query(
        `
          UPDATE products
          SET
            shopify_status = $2,
            shopify_product_id = $3,
            shopify_variant_id = $4,
            shopify_inventory_item_id = $5,
            product_data =
              COALESCE(product_data, '{}'::jsonb)
              || jsonb_build_object(
                'shopify',
                jsonb_build_object(
                  'productId', $3::text,
                  'variantId', $4::text,
                  'inventoryItemId', $5::text,
                  'handle', $6::text,
                  'status', $2::text,
                  'imageUrl', $7::text,
                  'originalTitle', $8::text
                )
              ),
            updated_at = NOW()
          WHERE id = $1
          RETURNING
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
        `,
        [
          existing.id,
          shopifyProduct.status ??
            "LINKED",
          shopifyProduct.id,
          variant.id,
          variant.inventoryItemId,
          shopifyProduct.handle,
          shopifyProduct.imageUrl,
          shopifyProduct.title,
        ]
      );

      const updated =
        result.rows[0] as ProductMasterRow;

      return {
        imported: false,
        alreadyLinked: false,
        linkedExisting: true,
        matchedBy: "TITLE_SIZE",
        productMaster: updated,
        shopifyProduct,
      };
    }
  }

  const shopifyFoodData =
    buildShopifyFoodData(
      shopifyProduct
    );

  const productData = {
    title: normalizedTitle,
    barcode,
    vendor: shopifyProduct.vendor,
    brand: null,
    productType:
      shopifyProduct.productType,
    ...shopifyFoodData,
    unitSize:
      shopifyFoodData.unitSize ??
      extractProductSize(
        shopifyProduct.title
      ),
    sellingPrice:
      variant.price,
    commerce: {
      sellingPrice:
        variant.price,
    },
    shopify: {
      productId:
        shopifyProduct.id,
      variantId:
        variant.id,
      inventoryItemId:
        variant.inventoryItemId,
      handle:
        shopifyProduct.handle,
      status:
        shopifyProduct.status,
      imageUrl:
        shopifyProduct.imageUrl,
      originalTitle:
        shopifyProduct.title,
    },
    warnings: barcode
      ? []
      : ["BARCODE_MISSING"],
  };

  const reviewStatus = barcode
    ? "REVIEWED"
    : "NEEDS_REVIEW";

  const result = await db.query(
    `
      INSERT INTO products (
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
      )
      VALUES (
        $1,
        $2,
        $3::jsonb,
        'shopify_import',
        $4,
        $5,
        $6,
        $7,
        $8,
        NOW()
      )
      RETURNING
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
    `,
    [
      barcode,
      normalizedTitle,
      JSON.stringify(productData),
      reviewStatus,
      shopifyProduct.status ??
        "LINKED",
      shopifyProduct.id,
      variant.id,
      variant.inventoryItemId,
    ]
  );

  return {
    imported: true,
    alreadyLinked: false,
    linkedExisting: false,
    productMaster: result.rows[0],
    shopifyProduct,
  };
}

export async function importShopifyCatalogBatch(
  limit?: number
) {
  const [shopifyProducts, initialMaster] =
    await Promise.all([
      loadShopifyCatalog(),
      loadProductMaster(),
    ]);

  const productMaster =
    [...initialMaster];

  const linkedIds = new Set(
    productMaster
      .map(
        (product) =>
          product.shopify_product_id
      )
      .filter(
        (value): value is string =>
          Boolean(value)
      )
  );

  const unlinkedProducts =
    shopifyProducts.filter(
      (product) =>
        !linkedIds.has(product.id)
    );

  const titleSizeClaims = new Map<
    string,
    number
  >();

  for (const shopifyProduct of unlinkedProducts) {
    if (
      shopifyProduct.variantsTruncated ||
      shopifyProduct.variants.length !== 1
    ) {
      continue;
    }

    const variant =
      shopifyProduct.variants[0];

    const barcode =
      normalizeProductBarcode(
        variant.barcode
      );

    if (barcode) {
      continue;
    }

    const titleSizeCandidates =
      productMaster.filter(
        (product) =>
          titleSizeMatches(
            shopifyProduct.title,
            product
          )
      );

    if (titleSizeCandidates.length === 1) {
      const productMasterId =
        String(titleSizeCandidates[0].id);

      titleSizeClaims.set(
        productMasterId,
        (titleSizeClaims.get(productMasterId) ?? 0) + 1
      );
    }
  }

  const candidates =
    unlinkedProducts.filter(
      (shopifyProduct) => {
        if (
          shopifyProduct.variantsTruncated ||
          shopifyProduct.variants.length !== 1
        ) {
          return false;
        }

        const variant =
          shopifyProduct.variants[0];

        const barcode =
          normalizeProductBarcode(
            variant.barcode
          );

        if (barcode) {
          const barcodeMatches =
            productMaster.filter(
              (product) =>
                normalizeProductBarcode(
                  product.barcode
                ) === barcode
            );

          if (barcodeMatches.length === 0) {
            return true;
          }

          if (barcodeMatches.length > 1) {
            return false;
          }

          const existing =
            barcodeMatches[0];

          return (
            !existing.shopify_product_id ||
            existing.shopify_product_id ===
              shopifyProduct.id
          );
        }

        const titleSizeCandidates =
          productMaster.filter(
            (product) =>
              titleSizeMatches(
                shopifyProduct.title,
                product
              )
          );

        if (titleSizeCandidates.length === 0) {
          return true;
        }

        if (titleSizeCandidates.length > 1) {
          return false;
        }

        const existing =
          titleSizeCandidates[0];

        if (
          existing.shopify_product_id &&
          existing.shopify_product_id !==
            shopifyProduct.id
        ) {
          return false;
        }

        const productMasterId =
          String(existing.id);

        return (
          titleSizeClaims.get(productMasterId) === 1
        );
      }
    );

  const skippedReview =
    unlinkedProducts.length -
    candidates.length;

  const selected =
    typeof limit === "number" &&
    Number.isFinite(limit) &&
    limit > 0
      ? candidates.slice(
          0,
          Math.floor(limit)
        )
      : candidates;

  const results: any[] = [];

  let imported = 0;
  let alreadyLinked = 0;
  let linkedExisting = 0;
  let failed = 0;

  for (const shopifyProduct of selected) {
    try {
      const result =
        await importShopifyCatalogProductFromSnapshot(
          shopifyProduct,
          productMaster
        );

      if (result.imported) {
        imported += 1;
      } else if (result.alreadyLinked) {
        alreadyLinked += 1;
      } else if (result.linkedExisting) {
        linkedExisting += 1;
      }

      if (result.productMaster) {
        const existingIndex =
          productMaster.findIndex(
            (row) =>
              String(row.id) ===
              String(
                result.productMaster.id
              )
          );

        if (existingIndex >= 0) {
          productMaster[existingIndex] =
            result.productMaster;
        } else {
          productMaster.push(
            result.productMaster
          );
        }

        if (
          result.productMaster
            .shopify_product_id
        ) {
          linkedIds.add(
            result.productMaster
              .shopify_product_id
          );
        }
      }

      results.push({
        ok: true,
        shopifyProductId:
          shopifyProduct.id,
        title:
          shopifyProduct.title,
        imported:
          Boolean(result.imported),
        alreadyLinked:
          Boolean(result.alreadyLinked),
        linkedExisting:
          Boolean(result.linkedExisting),
        productMasterId:
          result.productMaster?.id
            ? String(
                result.productMaster.id
              )
            : null,
      });
    } catch (error) {
      failed += 1;

      results.push({
        ok: false,
        shopifyProductId:
          shopifyProduct.id,
        title:
          shopifyProduct.title,
        error:
          error instanceof Error
            ? error.message
            : "Import fehlgeschlagen.",
      });
    }
  }

  return {
    attempted: selected.length,
    eligible: candidates.length,
    skippedReview,
    imported,
    alreadyLinked,
    linkedExisting,
    failed,
    failures:
      results.filter(
        (item) => !item.ok
      ),
    results,
  };
}

export async function importShopifyProductToProductMaster(
  shopifyProductId: string
) {
  const productId = String(
    shopifyProductId ?? ""
  ).trim();

  if (!productId) {
    throw new Error(
      "Shopify Product ID fehlt."
    );
  }

  const [shopifyProducts, productMaster] =
    await Promise.all([
      loadShopifyCatalog(),
      loadProductMaster(),
    ]);

  const shopifyProduct =
    shopifyProducts.find(
      (product) =>
        product.id === productId
    );

  if (!shopifyProduct) {
    throw new Error(
      "Shopify-Produkt wurde nicht gefunden."
    );
  }

  const existingLinks =
    productMaster.filter(
      (product) =>
        product.shopify_product_id ===
        shopifyProduct.id
    );

  if (existingLinks.length > 1) {
    throw new Error(
      "Mehrere Product-Master-Produkte sind mit diesem Shopify-Produkt verknüpft."
    );
  }

  if (existingLinks.length === 1) {
    const existing =
      existingLinks[0];

    if (
      shopifyProduct.variantsTruncated ||
      shopifyProduct.variants.length !== 1
    ) {
      throw new Error(
        "Verknüpftes Shopify-Produkt hat mehrere Varianten und benötigt manuelle Prüfung."
      );
    }

    const variant =
      shopifyProduct.variants[0];

    const shopifyData =
      mergeShopifyProductData(
        existing.product_data,
        shopifyProduct,
        variant
      );

    const result = await db.query(
      `
        UPDATE products
        SET
          shopify_status = $2,
          shopify_variant_id = $3,
          shopify_inventory_item_id = $4,
          product_data =
            $5::jsonb,
          updated_at = NOW()
        WHERE id = $1
        RETURNING
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
      `,
      [
        existing.id,
        shopifyProduct.status ??
          existing.shopify_status ??
          "LINKED",
        variant.id,
        variant.inventoryItemId,
        JSON.stringify(shopifyData),
      ]
    );

    return {
      imported: false,
      alreadyLinked: true,
      refreshed: true,
      productMaster: result.rows[0],
      shopifyProduct,
    };
  }

  if (
    shopifyProduct.variantsTruncated ||
    shopifyProduct.variants.length !== 1
  ) {
    throw new Error(
      "Produkt hat mehrere Varianten und benötigt manuelle Prüfung."
    );
  }

  const variant =
    shopifyProduct.variants[0];

  const barcode =
    normalizeProductBarcode(
      variant.barcode
    ) || null;

  if (barcode) {
    const barcodeMatches =
      productMaster.filter(
        (product) =>
          normalizeProductBarcode(
            product.barcode
          ) === barcode
      );

    if (barcodeMatches.length > 1) {
      throw new Error(
        `EAN ${barcode} existiert mehrfach im Product Master.`
      );
    }

    if (barcodeMatches.length === 1) {
      const existing =
        barcodeMatches[0];



      if (
        existing.shopify_product_id &&
        existing.shopify_product_id !== shopifyProduct.id
      ) {
        throw new Error(
          `Product Master ${existing.id} ist bereits mit einem anderen Shopify-Produkt verknüpft.`
        );
      }

      const result = await db.query(
        `
          UPDATE products
          SET
            shopify_status = $2,
            shopify_product_id = $3,
            shopify_variant_id = $4,
            shopify_inventory_item_id = $5,
            product_data =
              COALESCE(product_data, '{}'::jsonb)
              || jsonb_build_object(
                'shopify',
                jsonb_build_object(
                  'productId', $3::text,
                  'variantId', $4::text,
                  'inventoryItemId', $5::text,
                  'handle', $6::text,
                  'status', $2::text,
                  'imageUrl', $7::text,
                  'originalTitle', $8::text
                )
              ),
            updated_at = NOW()
          WHERE id = $1
          RETURNING
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
        `,
        [
          existing.id,
          shopifyProduct.status ??
            "LINKED",
          shopifyProduct.id,
          variant.id,
          variant.inventoryItemId,
          shopifyProduct.handle,
          shopifyProduct.imageUrl,
          shopifyProduct.title,
        ]
      );

      return {
        imported: false,
        alreadyLinked: false,
        linkedExisting: true,
        matchedBy: "BARCODE",
        productMaster: result.rows[0],
        shopifyProduct,
      };
    }
  }

  const normalizedTitle =
    String(shopifyProduct.title ?? "")
      .trim()
      .toUpperCase();

  if (!normalizedTitle) {
    throw new Error(
      "Shopify-Produkt hat keinen gültigen Titel."
    );
  }

  if (!barcode) {
    const titleSizeCandidates =
      productMaster.filter(
        (product) =>
          titleSizeMatches(
            shopifyProduct.title,
            product
          )
      );

    if (titleSizeCandidates.length > 1) {
      throw new Error(
        "Produkt ohne EAN hat mehrere mögliche Product-Master-Treffer und benötigt manuelle Prüfung."
      );
    }

    if (titleSizeCandidates.length === 1) {
      const existing =
        titleSizeCandidates[0];



      if (
        existing.shopify_product_id &&
        existing.shopify_product_id !== shopifyProduct.id
      ) {
        throw new Error(
          `Product Master ${existing.id} ist bereits mit einem anderen Shopify-Produkt verknüpft.`
        );
      }

      const result = await db.query(
        `
          UPDATE products
          SET
            shopify_status = $2,
            shopify_product_id = $3,
            shopify_variant_id = $4,
            shopify_inventory_item_id = $5,
            product_data =
              COALESCE(product_data, '{}'::jsonb)
              || jsonb_build_object(
                'shopify',
                jsonb_build_object(
                  'productId', $3::text,
                  'variantId', $4::text,
                  'inventoryItemId', $5::text,
                  'handle', $6::text,
                  'status', $2::text,
                  'imageUrl', $7::text,
                  'originalTitle', $8::text
                )
              ),
            updated_at = NOW()
          WHERE id = $1
          RETURNING
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
        `,
        [
          existing.id,
          shopifyProduct.status ??
            "LINKED",
          shopifyProduct.id,
          variant.id,
          variant.inventoryItemId,
          shopifyProduct.handle,
          shopifyProduct.imageUrl,
          shopifyProduct.title,
        ]
      );

      const updated =
        result.rows[0] as ProductMasterRow;

      return {
        imported: false,
        alreadyLinked: false,
        linkedExisting: true,
        matchedBy: "TITLE_SIZE",
        productMaster: updated,
        shopifyProduct,
      };
    }
  }

  const shopifyFoodData =
    buildShopifyFoodData(
      shopifyProduct
    );

  const productData = {
    title: normalizedTitle,
    barcode,
    vendor: shopifyProduct.vendor,
    brand: null,
    productType:
      shopifyProduct.productType,
    ...shopifyFoodData,
    unitSize:
      shopifyFoodData.unitSize ??
      extractProductSize(
        shopifyProduct.title
      ),
    sellingPrice:
      variant.price,
    commerce: {
      sellingPrice:
        variant.price,
    },
    shopify: {
      productId:
        shopifyProduct.id,
      variantId:
        variant.id,
      inventoryItemId:
        variant.inventoryItemId,
      handle:
        shopifyProduct.handle,
      status:
        shopifyProduct.status,
      imageUrl:
        shopifyProduct.imageUrl,
      originalTitle:
        shopifyProduct.title,
    },
    warnings: barcode
      ? []
      : ["BARCODE_MISSING"],
  };

  const reviewStatus = barcode
    ? "REVIEWED"
    : "NEEDS_REVIEW";

  const result = await db.query(
    `
      INSERT INTO products (
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
      )
      VALUES (
        $1,
        $2,
        $3::jsonb,
        'shopify_import',
        $4,
        $5,
        $6,
        $7,
        $8,
        NOW()
      )
      RETURNING
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
    `,
    [
      barcode,
      normalizedTitle,
      JSON.stringify(productData),
      reviewStatus,
      shopifyProduct.status ??
        "LINKED",
      shopifyProduct.id,
      variant.id,
      variant.inventoryItemId,
    ]
  );

  return {
    imported: true,
    alreadyLinked: false,
    linkedExisting: false,
    productMaster: result.rows[0],
    shopifyProduct,
  };
}

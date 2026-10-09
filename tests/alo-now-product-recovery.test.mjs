
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  "src/services/shopifyProductRecovery.service.ts",
  "utf8"
);

function makeClient(responseData) {
  const requests = [];

  const transformed = source
    .replace(/^import .*;\s*$/gm, "")
    .replace(
      /export type ShopifyRecoveryProduct = \{[\s\S]*?\n\};/,
      ""
    )
    .replace(
      /export async function fetchCurrentShopifyProduct\([\s\S]*?\n\> \{/,
      "async function fetchCurrentShopifyProduct(productId) {"
    )
    .replace(
      /function normalizeProductId\(value: string\): string/,
      "function normalizeProductId(value)"
    )
    .replace(
      /function normalizeShop\(value: string\): string/,
      "function normalizeShop(value)"
    )
    .replace(
      /const variants = product\.variants\.nodes\.map\(\(variant: any\) =>/,
      "const variants = product.variants.nodes.map((variant) =>"
    );

  const context = vm.createContext({
    axios: {
      post: async (url, body, options) => {
        requests.push({ url, body, options });
        return { data: responseData };
      },
    },
    env: { shopify: { shop: "alo-test.myshopify.com" } },
    getShopifyAccessToken: async () => "TEST_TOKEN",
  });

  vm.runInContext(
    transformed +
      "\nglobalThis.fetchProduct = fetchCurrentShopifyProduct;",
    context
  );

  return {
    fetchProduct: context.fetchProduct,
    requests,
  };
}

function validProduct() {
  return {
    id: "gid://shopify/Product/123",
    title: "ALO TEST DRINK",
    status: "ACTIVE",
    vendor: "ALO",
    productType: "Drink",
    handle: "alo-test-drink",
    descriptionHtml: "<p>Test</p>",
    tags: ["Drink"],
    featuredMedia: null,
    variants: {
      nodes: [{
        id: "gid://shopify/ProductVariant/456",
        barcode: "7612345678901",
        price: "3.50",
        inventoryItem: {
          id: "gid://shopify/InventoryItem/789",
        },
      }],
      pageInfo: { hasNextPage: false },
    },
  };
}

test("Aktuelles Produkt wird korrekt gelesen", async () => {
  const client = makeClient({
    data: { product: validProduct() },
  });

  const result = await client.fetchProduct("123");

  assert.equal(result.status, "FOUND");
  assert.equal(result.product.title, "ALO TEST DRINK");
  assert.equal(result.product.variants[0].price, "3.50");
  assert.equal(
    client.requests[0].body.variables.id,
    "gid://shopify/Product/123"
  );
  assert.match(client.requests[0].body.query, /query AloProductRecoveryRead/);
});

test("Nicht gefundenes Produkt wird erkannt", async () => {
  const client = makeClient({
    data: { product: null },
  });

  const result = await client.fetchProduct("123");
  assert.equal(result.status, "NOT_FOUND");
});

test("Unvollständige Varianten werden abgewiesen", async () => {
  const product = validProduct();
  product.variants.pageInfo.hasNextPage = true;

  const client = makeClient({
    data: { product },
  });

  await assert.rejects(
    client.fetchProduct("123"),
    /ALO_PRODUCT_RECOVERY_INCOMPLETE_PRODUCT/
  );
});

test("GraphQL-Fehler verhindern Verarbeitung", async () => {
  const client = makeClient({
    errors: [{ message: "Access denied" }],
    data: { product: validProduct() },
  });

  await assert.rejects(
    client.fetchProduct("123"),
    /ALO_PRODUCT_RECOVERY_GRAPHQL_ERROR/
  );
});

test("Ungültiger Preis wird abgewiesen", async () => {
  const product = validProduct();
  product.variants.nodes[0].price = "INVALID";

  const client = makeClient({
    data: { product },
  });

  await assert.rejects(
    client.fetchProduct("123"),
    /ALO_PRODUCT_RECOVERY_INVALID_VARIANT/
  );
});

test("Ungültige Produkt-ID wird vor API-Aufruf abgewiesen", async () => {
  const client = makeClient({
    data: { product: validProduct() },
  });

  await assert.rejects(
    client.fetchProduct("not-a-product-id"),
    /ALO_PRODUCT_RECOVERY_INVALID_ID/
  );

  assert.equal(client.requests.length, 0);
});

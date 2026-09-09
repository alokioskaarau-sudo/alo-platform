import type { PoolClient } from "pg";
import { db } from "../database/db.js";
import {
  extractProductSize,
  normalizeProductIdentityText,
  stripProductSize,
} from "./productIdentity.service.js";

type Queryable = {
  query: (
    text: string,
    values?: any[]
  ) => Promise<any>;
};

export type ReceivingProductMasterMatch =
  | {
      status: "MATCH";
      matchedBy:
        | "BARCODE"
        | "SUPPLIER_ARTICLE"
        | "TITLE_SIZE";
      confidence: number;
      product: any;
    }
  | {
      status: "AMBIGUOUS";
      matchedBy: "TITLE_SIZE";
      matches: Array<{
        product: any;
        confidence: number;
      }>;
    }
  | {
      status: "NO_MATCH";
    };

const GENERIC_WORDS = new Set([
  "snack",
  "snacks",
  "deutschland",
  "germany",
  "import",
  "artikel",
  "product",
  "produkt",
  "pcs",
  "stk",
  "stuck",
  "stück",
  "controller",
]);

const TOKEN_ALIASES: Record<string, string> = {
  salz: "salt",
  salted: "salt",
  chili: "chilli",
  kid: "kids",
};

function normalizeSupplier(
  value: unknown
): string {
  return normalizeProductIdentityText(value);
}

function normalizeArticleNumber(
  value: unknown
): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function titleTokens(
  value: unknown
): string[] {
  const base = stripProductSize(value);

  return Array.from(
    new Set(
      base
        .split(" ")
        .map((token) => TOKEN_ALIASES[token] ?? token)
        .filter(
          (token) =>
            token.length >= 2 &&
            !GENERIC_WORDS.has(token)
        )
    )
  );
}

function isSafeTitleContainment(
  source: unknown,
  candidate: unknown
): boolean {
  const sourceTokens = titleTokens(source);
  const candidateTokens =
    titleTokens(candidate);

  if (
    sourceTokens.length === 0 ||
    candidateTokens.length === 0
  ) {
    return false;
  }

  const sourceSet =
    new Set(sourceTokens);

  const candidateSet =
    new Set(candidateTokens);

  const allSourceTokensPresent =
    sourceTokens.every((token) =>
      candidateSet.has(token)
    );

  const meaningfulCandidateExtras =
    candidateTokens.filter(
      (token) => !sourceSet.has(token)
    );

  return (
    allSourceTokensPresent &&
    meaningfulCandidateExtras.length === 0
  );
}

function scoreTitles(
  source: unknown,
  candidate: unknown
): number {
  const sourceTokens = titleTokens(source);
  const candidateTokens = titleTokens(candidate);

  if (
    sourceTokens.length === 0 ||
    candidateTokens.length === 0
  ) {
    return 0;
  }

  const sourceSet = new Set(sourceTokens);
  const candidateSet = new Set(candidateTokens);

  const common = sourceTokens.filter(
    (token) => candidateSet.has(token)
  ).length;

  const sourceCoverage =
    common / sourceTokens.length;

  const candidateCoverage =
    common / candidateTokens.length;

  // Der Lieferschein ist häufig kürzer als unser
  // Product-Master-Titel. Deshalb zählt Source-Coverage
  // stärker als Candidate-Coverage.
  return (
    sourceCoverage * 0.75 +
    candidateCoverage * 0.25
  );
}

function candidateTitle(
  row: any
): string {
  return String(
    row?.product_data?.title ??
      row?.title ??
      ""
  );
}

function candidateSize(
  row: any
): string | null {
  return extractProductSize(
    row?.product_data?.unitSize,
    row?.product_data?.netWeight,
    row?.product_data?.title,
    row?.title
  );
}

async function ensureSupplierArticleTable(
  queryable: Queryable
) {
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS
      product_supplier_articles (
        id BIGSERIAL PRIMARY KEY,
        product_id BIGINT NOT NULL
          REFERENCES products(id)
          ON DELETE CASCADE,
        supplier_key TEXT NOT NULL,
        supplier_name TEXT NOT NULL,
        article_number_key TEXT NOT NULL,
        article_number TEXT NOT NULL,
        created_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),
        UNIQUE(
          supplier_key,
          article_number_key
        )
      )
  `);

  await queryable.query(`
    CREATE INDEX IF NOT EXISTS
      product_supplier_articles_product_idx
    ON product_supplier_articles(product_id)
  `);
}

const PRODUCT_SELECT = `
  SELECT
    id,
    barcode,
    title,
    product_data,
    review_status,
    shopify_status,
    shopify_product_id,
    shopify_variant_id,
    shopify_inventory_item_id
  FROM products
`;

export async function resolveReceivingProductMaster(
  input: {
    barcode?: unknown;
    supplier?: unknown;
    articleNumber?: unknown;
    title?: unknown;
    unitSize?: unknown;
  },
  client?: PoolClient
): Promise<ReceivingProductMasterMatch> {
  const queryable: Queryable =
    client ?? db;

  await ensureSupplierArticleTable(
    queryable
  );

  const barcode = String(
    input.barcode ?? ""
  )
    .replace(/\s+/g, "")
    .trim();

  if (barcode) {
    const result = await queryable.query(
      `${PRODUCT_SELECT}
       WHERE barcode = $1
       LIMIT 1`,
      [barcode]
    );

    if (result.rows[0]) {
      return {
        status: "MATCH",
        matchedBy: "BARCODE",
        confidence: 1,
        product: result.rows[0],
      };
    }
  }

  const supplierKey =
    normalizeSupplier(input.supplier);

  const articleNumberKey =
    normalizeArticleNumber(
      input.articleNumber
    );

  if (
    supplierKey &&
    articleNumberKey
  ) {
    const result = await queryable.query(
      `
        SELECT
          p.id,
          p.barcode,
          p.title,
          p.product_data,
          p.review_status,
          p.shopify_status,
          p.shopify_product_id,
          p.shopify_variant_id,
          p.shopify_inventory_item_id
        FROM product_supplier_articles psa
        JOIN products p
          ON p.id = psa.product_id
        WHERE
          psa.supplier_key = $1
          AND psa.article_number_key = $2
        LIMIT 1
      `,
      [
        supplierKey,
        articleNumberKey,
      ]
    );

    if (result.rows[0]) {
      return {
        status: "MATCH",
        matchedBy:
          "SUPPLIER_ARTICLE",
        confidence: 1,
        product: result.rows[0],
      };
    }
  }

  const sourceTitle = String(
    input.title ?? ""
  ).trim();

  const sourceSize =
    extractProductSize(
      input.unitSize,
      sourceTitle
    );

  if (
    !sourceTitle ||
    !sourceSize
  ) {
    return {
      status: "NO_MATCH",
    };
  }

  const sourceTokens =
    titleTokens(sourceTitle);

  if (!sourceTokens.length) {
    return {
      status: "NO_MATCH",
    };
  }

  /*
   * Erst grob Kandidaten aus PostgreSQL holen.
   * Keine externe Shopify-Suche nötig.
   */
  const result = await queryable.query(
    `${PRODUCT_SELECT}
     WHERE
       title IS NOT NULL
       AND (
         ${sourceTokens
           .slice(0, 8)
           .map(
             (_, index) =>
               `LOWER(title) LIKE $${index + 1}`
           )
           .join(" OR ")}
       )
     LIMIT 150`,
    sourceTokens
      .slice(0, 8)
      .map((token) => `%${token}%`)
  );

  const scored = result.rows
    .map((product: any) => {
      const size =
        candidateSize(product);

      if (
        !size ||
        size !== sourceSize
      ) {
        return null;
      }

      const confidence =
        scoreTitles(
          sourceTitle,
          candidateTitle(product)
        );

      return {
        product,
        confidence,
      };
    })
    .filter(Boolean)
    .sort(
      (a: any, b: any) =>
        b.confidence -
        a.confidence
    );

  if (!scored.length) {
    return {
      status: "NO_MATCH",
    };
  }

  const best = scored[0];
  const second = scored[1];

  /*
   * Auto-Match nur wenn:
   * - Lieferschein-Tokens sehr stark abgedeckt sind
   * - und kein fast gleich guter Konkurrent existiert.
   *
   * XBOX SALT 90G
   * -> XBOX SALT CONTROLLER ... 90G
   * soll hier durchkommen.
   */
  const safeTitleMatch =
    isSafeTitleContainment(
      sourceTitle,
      candidateTitle(best.product)
    );

  if (
    best.confidence >= 0.82 &&
    safeTitleMatch &&
    (
      !second ||
      best.confidence -
        second.confidence >= 0.08
    )
  ) {
    return {
      status: "MATCH",
      matchedBy: "TITLE_SIZE",
      confidence: best.confidence,
      product: best.product,
    };
  }

  return {
    status: "AMBIGUOUS",
    matchedBy: "TITLE_SIZE",
    matches: scored
      .slice(0, 5)
      .map((entry: any) => ({
        product: entry.product,
        confidence:
          entry.confidence,
      })),
  };
}

export async function rememberSupplierArticle(
  input: {
    productId: string | number;
    supplier?: unknown;
    articleNumber?: unknown;
  },
  client?: PoolClient
): Promise<boolean> {
  const queryable: Queryable =
    client ?? db;

  await ensureSupplierArticleTable(
    queryable
  );

  const supplierName =
    String(input.supplier ?? "").trim();

  const supplierKey =
    normalizeSupplier(
      supplierName
    );

  const articleNumber =
    String(
      input.articleNumber ?? ""
    ).trim();

  const articleNumberKey =
    normalizeArticleNumber(
      articleNumber
    );

  if (
    !supplierKey ||
    !articleNumberKey
  ) {
    return false;
  }

  const existing =
    await queryable.query(
      `
        SELECT
          product_id
        FROM product_supplier_articles
        WHERE
          supplier_key = $1
          AND article_number_key = $2
        LIMIT 1
      `,
      [
        supplierKey,
        articleNumberKey,
      ]
    );

  const existingProductId =
    existing.rows[0]?.product_id
      ? String(
          existing.rows[0].product_id
        )
      : null;

  if (
    existingProductId &&
    existingProductId !==
      String(input.productId)
  ) {
    throw new Error(
      `Lieferanten-Artikelnummer ist bereits Product Master ${existingProductId} zugeordnet.`
    );
  }

  await queryable.query(
    `
      INSERT INTO
        product_supplier_articles (
          product_id,
          supplier_key,
          supplier_name,
          article_number_key,
          article_number,
          updated_at
        )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        NOW()
      )
      ON CONFLICT (
        supplier_key,
        article_number_key
      )
      DO UPDATE SET
        supplier_name =
          EXCLUDED.supplier_name,
        article_number =
          EXCLUDED.article_number,
        updated_at = NOW()
    `,
    [
      input.productId,
      supplierKey,
      supplierName,
      articleNumberKey,
      articleNumber,
    ]
  );

  return true;
}

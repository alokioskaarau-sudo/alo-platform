import {
  readFile,
} from "node:fs/promises";

import {
  fileURLToPath,
} from "node:url";

import {
  dirname,
  resolve,
} from "node:path";

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

import {
  reservePackingSlip,
  completePackingSlip,
} from "../../database/packingSlips.js";

import {
  getOrCreatePackingSlipDiscount,
} from "./packingSlipDiscount.service.js";

type ShopifyOrder = {
  id: string;
  name: string;
  createdAt?: string;
  email?: string | null;

  shippingAddress?: {
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    address1?: string | null;
    address2?: string | null;
    zip?: string | null;
    city?: string | null;
    province?: string | null;
    country?: string | null;
  } | null;

  lineItems?: {
    edges?: Array<{
      node?: {
        name?: string | null;
        quantity?: number;
        sku?: string | null;
        variant?: {
          title?: string | null;
        } | null;
      };
    }>;
  };
};

/* =========================================================
   PDF HELPERS
========================================================= */

function formatDate(value?: string): string {
  if (!value) {
    return new Date().toLocaleDateString(
      "de-CH"
    );
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return new Date().toLocaleDateString(
      "de-CH"
    );
  }

  return date.toLocaleDateString(
    "de-CH"
  );
}

function cleanPdfText(
  value: unknown
): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateToWidth(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string {
  const clean =
    cleanPdfText(text);

  if (
    font.widthOfTextAtSize(
      clean,
      size
    ) <= maxWidth
  ) {
    return clean;
  }

  const suffix = "...";
  let candidate = clean;

  while (
    candidate.length > 0 &&
    font.widthOfTextAtSize(
      candidate + suffix,
      size
    ) > maxWidth
  ) {
    candidate =
      candidate.slice(0, -1);
  }

  return (
    candidate.trimEnd() +
    suffix
  );
}

function wrapTextToWidth(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string[] {
  const clean =
    cleanPdfText(text);

  if (!clean) {
    return [];
  }

  const words =
    clean.split(" ");

  const lines: string[] = [];
  let current = "";

  for (const originalWord of words) {
    let word = originalWord;

    if (
      font.widthOfTextAtSize(
        word,
        size
      ) > maxWidth
    ) {
      if (current) {
        lines.push(current);
        current = "";
      }

      while (word.length > 0) {
        let part = "";

        while (
          word.length > 0
        ) {
          const candidate =
            part + word[0];

          if (
            part &&
            font.widthOfTextAtSize(
              candidate,
              size
            ) > maxWidth
          ) {
            break;
          }

          part = candidate;
          word = word.slice(1);
        }

        if (part) {
          lines.push(part);
        } else {
          break;
        }
      }

      continue;
    }

    const candidate =
      current
        ? `${current} ${word}`
        : word;

    if (
      font.widthOfTextAtSize(
        candidate,
        size
      ) <= maxWidth
    ) {
      current = candidate;
    } else {
      if (current) {
        lines.push(current);
      }

      current = word;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function centeredX(
  text: string,
  font: PDFFont,
  size: number,
  pageWidth: number
): number {
  const width =
    font.widthOfTextAtSize(
      text,
      size
    );

  return Math.max(
    48,
    (pageWidth - width) / 2
  );
}

function drawDivider(
  page: PDFPage,
  y: number,
  left: number,
  right: number,
  thickness = 0.7
) {
  page.drawLine({
    start: {
      x: left,
      y,
    },
    end: {
      x: right,
      y,
    },
    thickness,
    color: rgb(
      0.72,
      0.72,
      0.72
    ),
  });
}

function drawSectionLabel(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  bold: PDFFont
) {
  page.drawText(
    text.toUpperCase(),
    {
      x,
      y,
      size: 9,
      font: bold,
      color: rgb(
        0.16,
        0.16,
        0.16
      ),
    }
  );
}

type PackingSlipPdfInput = {
  orderName: string;
  date: string;
  email?: string | null;
  discountCode: string;
  addressLines: string[];
  items: Array<{
    quantity: number;
    name: string;
    sku: string;
    variant: string;
  }>;
};

/* =========================================================
   A4 PACKING SLIP PDF
========================================================= */

export async function createPackingSlipPdf(
  input: PackingSlipPdfInput
): Promise<string> {
  const pdf =
    await PDFDocument.create();

  const regular =
    await pdf.embedFont(
      StandardFonts.Helvetica
    );

  const bold =
    await pdf.embedFont(
      StandardFonts.HelveticaBold
    );

  const currentDir =
    dirname(
      fileURLToPath(
        import.meta.url
      )
    );

  /*
   * Funktioniert sowohl:
   * - lokal aus src/modules/shipping
   * - nach Build aus dist/modules/shipping
   *
   * Beide liegen drei Ebenen unter dem
   * Projekt-Root.
   */
  const logoPath =
    resolve(
      currentDir,
      "../../../assets/packing-slip/alo-kiosk-logo.png"
    );

  const logoBytes =
    await readFile(
      logoPath
    );

  const logo =
    await pdf.embedPng(
      logoBytes
    );

  const PAGE_WIDTH = 595.28;
  const PAGE_HEIGHT = 841.89;

  const LEFT = 48;
  const RIGHT = 547;
  const CONTENT_WIDTH =
    RIGHT - LEFT;

  const ITEM_NAME_X =
    LEFT + 65;

  const SKU_X = 455;

  const ITEM_NAME_WIDTH =
    SKU_X -
    ITEM_NAME_X -
    18;

  const SKU_WIDTH =
    RIGHT -
    SKU_X -
    5;

  /*
   * Der Rabattbereich bleibt auf der
   * letzten Seite frei.
   */
  const LAST_PAGE_ITEMS_BOTTOM =
    220;

  const NORMAL_PAGE_ITEMS_BOTTOM =
    78;

  let pageNumber = 0;

  function createPage(
    continuation = false
  ) {
    const page =
      pdf.addPage([
        PAGE_WIDTH,
        PAGE_HEIGHT,
      ]);

    pageNumber += 1;

    /*
     * Echtes ALO-Logo.
     * PNG bleibt farbig und transparent.
     */
    const logoSize = 94;

    page.drawImage(
      logo,
      {
        x: LEFT - 5,
        y:
          PAGE_HEIGHT -
          52 -
          logoSize,
        width: logoSize,
        height: logoSize,
      }
    );

    page.drawText(
      "ONLINE SHOP",
      {
        x: LEFT + 98,
        y: 770,
        size: 8,
        font: bold,
        color: rgb(
          0.28,
          0.28,
          0.28
        ),
      }
    );

    page.drawText(
      continuation
        ? "LIEFERSCHEIN · FORTSETZUNG"
        : "LIEFERSCHEIN",
      {
        x:
          continuation
            ? 350
            : 407,
        y: 792,
        size:
          continuation
            ? 11
            : 17,
        font: bold,
        color: rgb(
          0.08,
          0.08,
          0.08
        ),
      }
    );

    const orderText =
      `Bestellung ${input.orderName}`;

    page.drawText(
      truncateToWidth(
        orderText,
        regular,
        9,
        145
      ),
      {
        x: 402,
        y: 770,
        size: 9,
        font: regular,
      }
    );

    page.drawText(
      input.date,
      {
        x: 402,
        y: 754,
        size: 9,
        font: regular,
      }
    );

    if (pageNumber > 1) {
      const pageLabel =
        `Seite ${pageNumber}`;

      page.drawText(
        pageLabel,
        {
          x:
            RIGHT -
            regular.widthOfTextAtSize(
              pageLabel,
              8
            ),
          y: 730,
          size: 8,
          font: regular,
          color: rgb(
            0.4,
            0.4,
            0.4
          ),
        }
      );
    }

    drawDivider(
      page,
      718,
      LEFT,
      RIGHT,
      1
    );

    return page;
  }

  function drawTableHeader(
    page: PDFPage,
    y: number
  ): number {
    page.drawRectangle({
      x: LEFT,
      y: y - 7,
      width: CONTENT_WIDTH,
      height: 24,
      color: rgb(
        0.95,
        0.95,
        0.95
      ),
    });

    page.drawText(
      "MENGE",
      {
        x: LEFT + 8,
        y,
        size: 8,
        font: bold,
      }
    );

    page.drawText(
      "ARTIKEL",
      {
        x: ITEM_NAME_X,
        y,
        size: 8,
        font: bold,
      }
    );

    page.drawText(
      "SKU",
      {
        x: SKU_X,
        y,
        size: 8,
        font: bold,
      }
    );

    return y - 29;
  }

  function getItemHeight(
    item:
      PackingSlipPdfInput["items"][number]
  ): {
    height: number;
    nameLines: string[];
    skuLines: string[];
    showVariant: boolean;
  } {
    const nameLines =
      wrapTextToWidth(
        item.name || "Artikel",
        regular,
        9.5,
        ITEM_NAME_WIDTH
      );

    const skuLines =
      item.sku
        ? wrapTextToWidth(
            item.sku,
            regular,
            7.5,
            SKU_WIDTH
          )
        : [];

    const showVariant =
      Boolean(
        item.variant &&
        item.variant !==
          "Default Title"
      );

    const nameHeight =
      Math.max(
        1,
        nameLines.length
      ) * 13;

    const skuHeight =
      Math.max(
        1,
        skuLines.length
      ) * 11;

    const variantHeight =
      showVariant
        ? 13
        : 0;

    return {
      height:
        Math.max(
          nameHeight +
            variantHeight,
          skuHeight,
          18
        ) + 15,

      nameLines:
        nameLines.length
          ? nameLines
          : ["Artikel"],

      skuLines,

      showVariant,
    };
  }

  function drawItem(
    page: PDFPage,
    y: number,
    item:
      PackingSlipPdfInput["items"][number],
    layout:
      ReturnType<
        typeof getItemHeight
      >
  ): number {
    page.drawText(
      String(
        item.quantity ?? 0
      ),
      {
        x: LEFT + 12,
        y,
        size: 10,
        font: bold,
      }
    );

    let nameY = y;

    for (
      const line
      of layout.nameLines
    ) {
      page.drawText(
        line,
        {
          x: ITEM_NAME_X,
          y: nameY,
          size: 9.5,
          font: regular,
        }
      );

      nameY -= 13;
    }

    if (
      layout.showVariant
    ) {
      page.drawText(
        truncateToWidth(
          `Variante: ${item.variant}`,
          regular,
          7.5,
          ITEM_NAME_WIDTH
        ),
        {
          x: ITEM_NAME_X,
          y: nameY,
          size: 7.5,
          font: regular,
          color: rgb(
            0.38,
            0.38,
            0.38
          ),
        }
      );
    }

    let skuY = y;

    for (
      const line
      of layout.skuLines
    ) {
      page.drawText(
        line,
        {
          x: SKU_X,
          y: skuY,
          size: 7.5,
          font: regular,
        }
      );

      skuY -= 11;
    }

    const dividerY =
      y -
      layout.height +
      8;

    drawDivider(
      page,
      dividerY,
      LEFT,
      RIGHT,
      0.35
    );

    return (
      y -
      layout.height
    );
  }

  /*
   * -------------------------------------------------------
   * ERSTE SEITE
   * -------------------------------------------------------
   */

  let page =
    createPage(false);

  drawSectionLabel(
    page,
    "Lieferadresse",
    LEFT,
    688,
    bold
  );

  let y = 665;

  for (
    const addressLine
    of input.addressLines
  ) {
    const lines =
      wrapTextToWidth(
        addressLine,
        regular,
        10,
        270
      );

    for (
      const line
      of lines
    ) {
      page.drawText(
        line,
        {
          x: LEFT,
          y,
          size: 10,
          font: regular,
        }
      );

      y -= 15;
    }
  }

  if (input.email) {
    y -= 3;

    page.drawText(
      truncateToWidth(
        `E-Mail: ${input.email}`,
        regular,
        8.5,
        300
      ),
      {
        x: LEFT,
        y,
        size: 8.5,
        font: regular,
        color: rgb(
          0.35,
          0.35,
          0.35
        ),
      }
    );

    y -= 16;
  }

  y -= 20;

  drawSectionLabel(
    page,
    "Bestellung",
    LEFT,
    y,
    bold
  );

  y -= 24;

  y =
    drawTableHeader(
      page,
      y
    );

  /*
   * Wir bestimmen vor jedem Artikel,
   * ob auf der aktuellen Seite genug
   * Platz vorhanden ist.
   *
   * Die letzte Seite reserviert unten
   * Platz für Versand + Rabatt.
   */
  for (
    let index = 0;
    index < input.items.length;
    index += 1
  ) {
    const item =
      input.items[index];

    const layout =
      getItemHeight(
        item
      );

    /*
     * Zunächst konservativ den
     * Rabattbereich freihalten.
     */
    if (
      y -
        layout.height <
      LAST_PAGE_ITEMS_BOTTOM
    ) {
      /*
       * Wenn noch weitere Artikel
       * vorhanden sind, beginnen wir
       * eine Fortsetzungsseite.
       */
      page =
        createPage(true);

      drawSectionLabel(
        page,
        "Bestellung",
        LEFT,
        688,
        bold
      );

      y =
        drawTableHeader(
          page,
          658
        );
    }

    /*
     * Extrem hohe Einzelzeilen oder
     * sehr volle Folgeseiten zusätzlich
     * absichern.
     */
    if (
      y -
        layout.height <
      NORMAL_PAGE_ITEMS_BOTTOM
    ) {
      page =
        createPage(true);

      drawSectionLabel(
        page,
        "Bestellung",
        LEFT,
        688,
        bold
      );

      y =
        drawTableHeader(
          page,
          658
        );
    }

    y =
      drawItem(
        page,
        y,
        item,
        layout
      );
  }

  /*
   * -------------------------------------------------------
   * VERSAND + RABATT
   * immer auf der letzten Seite
   * -------------------------------------------------------
   */

  if (y < 215) {
    page =
      createPage(true);

    y = 665;
  }

  y -= 8;

  drawSectionLabel(
    page,
    "Versand",
    LEFT,
    y,
    bold
  );

  y -= 18;

  page.drawText(
    "Versand mit der Schweizerischen Post",
    {
      x: LEFT,
      y,
      size: 9,
      font: regular,
    }
  );

  /*
   * Fester hochwertiger Rabattbereich.
   */
  drawDivider(
    page,
    184,
    LEFT,
    RIGHT,
    0.8
  );

  const thankYou =
    "DANKE FÜR DEINE BESTELLUNG";

  page.drawText(
    thankYou,
    {
      x: centeredX(
        thankYou,
        bold,
        10,
        PAGE_WIDTH
      ),
      y: 160,
      size: 10,
      font: bold,
    }
  );

  const offer =
    "15% AUF DEINE NÄCHSTE BESTELLUNG";

  page.drawText(
    offer,
    {
      x: centeredX(
        offer,
        bold,
        12,
        PAGE_WIDTH
      ),
      y: 137,
      size: 12,
      font: bold,
    }
  );

  const code =
    cleanPdfText(
      input.discountCode
    );

  page.drawRectangle({
    x: 172,
    y: 96,
    width: 251,
    height: 31,
    borderWidth: 0.8,
    borderColor: rgb(
      0.18,
      0.18,
      0.18
    ),
  });

  page.drawText(
    code,
    {
      x: centeredX(
        code,
        bold,
        17,
        PAGE_WIDTH
      ),
      y: 105,
      size: 17,
      font: bold,
    }
  );

  const discountInfo =
    "Einmalig einlösbar im ALO Online Shop";

  page.drawText(
    discountInfo,
    {
      x: centeredX(
        discountInfo,
        regular,
        8,
        PAGE_WIDTH
      ),
      y: 79,
      size: 8,
      font: regular,
      color: rgb(
        0.35,
        0.35,
        0.35
      ),
    }
  );

  /*
   * -------------------------------------------------------
   * FOOTER AUF ALLEN SEITEN
   * -------------------------------------------------------
   */

  const pages =
    pdf.getPages();

  for (
    let index = 0;
    index < pages.length;
    index += 1
  ) {
    const footerPage =
      pages[index];

    drawDivider(
      footerPage,
      57,
      LEFT,
      RIGHT,
      0.6
    );

    const footer =
      "ALO KIOSK  ·  Zwischen den Toren 14  ·  5000 Aarau  ·  alokiosk.ch";

    footerPage.drawText(
      footer,
      {
        x: LEFT,
        y: 38,
        size: 7.5,
        font: regular,
        color: rgb(
          0.38,
          0.38,
          0.38
        ),
      }
    );

    if (pages.length > 1) {
      const pageText =
        `${index + 1} / ${pages.length}`;

      footerPage.drawText(
        pageText,
        {
          x:
            RIGHT -
            regular.widthOfTextAtSize(
              pageText,
              7.5
            ),
          y: 38,
          size: 7.5,
          font: regular,
          color: rgb(
            0.38,
            0.38,
            0.38
          ),
        }
      );
    }
  }

  const pdfBytes =
    await pdf.save();

  return Buffer
    .from(pdfBytes)
    .toString("base64");
}


/* =========================================================
   CREATE PACKING SLIP
========================================================= */

export async function createPackingSlipForOrder(
  order: ShopifyOrder
) {
  if (!order?.id) {
    throw new Error(
      "Shopify Bestellung hat keine Order ID."
    );
  }

  if (!order?.name) {
    throw new Error(
      "Shopify Bestellung hat keinen Bestellnamen."
    );
  }

  const reservation =
    await reservePackingSlip({
      shopifyOrderId: order.id,
      shopifyOrderName: order.name,
    });

  /*
   * Bereits erfolgreich erstellt:
   * niemals bei jedem Pipeline-Lauf neu erzeugen.
   */
  if (
    !reservation.created &&
    reservation.record.status ===
      "COMPLETED" &&
    reservation.record.pdf_base64
  ) {
    return {
      created: false,
      reused: true,
      id: reservation.record.id,
      pdfBase64:
        reservation.record.pdf_base64,
    };
  }

  /*
   * Genau einen echten Shopify-Rabattcode
   * pro Bestellung erstellen oder wiederverwenden.
   */
  const discount =
    await getOrCreatePackingSlipDiscount({
      id: order.id,
      name: order.name,
    });

  if (!discount?.code) {
    throw new Error(
      `Kein Lieferschein-Rabattcode für ${order.name} vorhanden.`
    );
  }

  const address =
    order.shippingAddress;

  const addressLines: string[] = [];

  if (address) {
    const fullName = [
      address.firstName,
      address.lastName,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();

    if (fullName) {
      addressLines.push(fullName);
    }

    if (address.company) {
      addressLines.push(
        address.company
      );
    }

    if (address.address1) {
      addressLines.push(
        address.address1
      );
    }

    if (address.address2) {
      addressLines.push(
        address.address2
      );
    }

    const location = [
      address.zip,
      address.city,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();

    if (location) {
      addressLines.push(location);
    }

    if (address.country) {
      addressLines.push(
        address.country
      );
    }
  }

  if (addressLines.length === 0) {
    addressLines.push(
      "Keine Lieferadresse vorhanden"
    );
  }

  const items =
    (
      order.lineItems?.edges ?? []
    )
      .map(
        (edge) => edge.node
      )
      .filter(
        (
          item
        ): item is NonNullable<
          typeof item
        > => Boolean(item)
      )
      .map((item) => ({
        quantity:
          item.quantity ?? 0,

        name:
          item.name?.trim() ||
          "Artikel",

        sku:
          item.sku?.trim() ||
          "",

        variant:
          item.variant?.title?.trim() ||
          "",
      }));

  const pdfBase64 =
    await createPackingSlipPdf({
      orderName: order.name,
      date: formatDate(
        order.createdAt
      ),
      email: order.email,
      discountCode: discount.code,
      addressLines,
      items,
    });

  const completed =
    await completePackingSlip(
      reservation.record.id,
      pdfBase64
    );

  return {
    created: true,
    reused: false,
    id: completed.id,
    pdfBase64,
    discountCode: discount.code,
  };
}

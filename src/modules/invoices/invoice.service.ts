import { readFile } from "node:fs/promises";
import {
  dirname,
  resolve,
} from "node:path";
import {
  fileURLToPath,
} from "node:url";

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

import {
  completeInvoice,
  failInvoice,
  reserveInvoice,
} from "../../database/invoices.js";


// ============================================================
// TYPES
// ============================================================

type MoneySet = {
  shopMoney?: {
    amount?: string | number | null;
    currencyCode?: string | null;
  } | null;
};

type ShopifyAddress = {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  zip?: string | null;
  city?: string | null;
  province?: string | null;
  provinceCode?: string | null;
  country?: string | null;
  countryCodeV2?: string | null;
  phone?: string | null;
};

type ShopifyInvoiceLineItem = {
  id?: string;
  name?: string | null;
  quantity?: number | null;
  sku?: string | null;
  originalUnitPriceSet?: MoneySet | null;
  discountedUnitPriceSet?: MoneySet | null;
  totalDiscountSet?: MoneySet | null;
};

export type ShopifyOrderForInvoice = {
  id: string;
  name: string;
  createdAt?: string | null;

  email?: string | null;

  subtotalPriceSet?: MoneySet | null;
  totalDiscountsSet?: MoneySet | null;
  totalShippingPriceSet?: MoneySet | null;
  totalTaxSet?: MoneySet | null;
  totalPriceSet?: MoneySet | null;

  billingAddress?: ShopifyAddress | null;
  shippingAddress?: ShopifyAddress | null;

  lineItems?: {
    edges?: Array<{
      node?: ShopifyInvoiceLineItem | null;
    }>;
  } | null;
};


// ============================================================
// CONSTANTS
// ============================================================

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

const MARGIN_X = 48;
const CONTENT_WIDTH =
  PAGE_WIDTH - MARGIN_X * 2;

const BLACK = rgb(0, 0, 0);
const GREY = rgb(
  0.38,
  0.38,
  0.38
);
const LIGHT_GREY = rgb(
  0.82,
  0.82,
  0.82
);


// ============================================================
// HELPERS
// ============================================================

function cleanText(
  value: unknown
): string {
  return String(
    value ?? ""
  )
    .replace(/\s+/g, " ")
    .trim();
}


function moneyValue(
  value?: MoneySet | null
): number {
  const amount =
    value
      ?.shopMoney
      ?.amount;

  const parsed =
    Number(amount ?? 0);

  return Number.isFinite(parsed)
    ? parsed
    : 0;
}


function currencyOf(
  order: ShopifyOrderForInvoice
): string {
  return (
    cleanText(
      order
        .totalPriceSet
        ?.shopMoney
        ?.currencyCode
    ) ||
    cleanText(
      order
        .subtotalPriceSet
        ?.shopMoney
        ?.currencyCode
    ) ||
    "CHF"
  );
}


function formatMoney(
  amount: number,
  currency: string
): string {
  return `${currency} ${amount.toFixed(2)}`;
}


function formatDate(
  value?: string | null
): string {
  if (!value) {
    return "";
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return cleanText(value);
  }

  return new Intl.DateTimeFormat(
    "de-CH",
    {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "Europe/Zurich",
    }
  ).format(date);
}


function invoiceNumberFromOrder(
  orderName: string
): string {
  const cleaned =
    cleanText(orderName)
      .replace(/^#/, "")
      .replace(
        /[^A-Za-z0-9_-]/g,
        ""
      );

  if (!cleaned) {
    throw new Error(
      "Keine gültige Bestellnummer für Rechnung vorhanden."
    );
  }

  return `RE-${cleaned}`;
}


function addressLines(
  address?: ShopifyAddress | null
): string[] {
  if (!address) {
    return [];
  }

  const result: string[] = [];

  const fullName =
    [
      cleanText(
        address.firstName
      ),
      cleanText(
        address.lastName
      ),
    ]
      .filter(Boolean)
      .join(" ");

  if (fullName) {
    result.push(fullName);
  }

  if (address.company) {
    result.push(
      cleanText(
        address.company
      )
    );
  }

  if (address.address1) {
    result.push(
      cleanText(
        address.address1
      )
    );
  }

  if (address.address2) {
    result.push(
      cleanText(
        address.address2
      )
    );
  }

  const location =
    [
      cleanText(
        address.zip
      ),
      cleanText(
        address.city
      ),
    ]
      .filter(Boolean)
      .join(" ");

  if (location) {
    result.push(location);
  }

  if (address.country) {
    result.push(
      cleanText(
        address.country
      )
    );
  }

  return result;
}


function truncateText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string {
  const cleaned =
    cleanText(text);

  if (
    font.widthOfTextAtSize(
      cleaned,
      size
    ) <= maxWidth
  ) {
    return cleaned;
  }

  let current = cleaned;

  while (
    current.length > 0 &&
    font.widthOfTextAtSize(
      `${current}...`,
      size
    ) > maxWidth
  ) {
    current =
      current.slice(
        0,
        -1
      );
  }

  return `${current}...`;
}


function drawLine(
  page: PDFPage,
  y: number
) {
  page.drawLine({
    start: {
      x: MARGIN_X,
      y,
    },
    end: {
      x:
        PAGE_WIDTH -
        MARGIN_X,
      y,
    },
    thickness: 0.7,
    color: LIGHT_GREY,
  });
}


// ============================================================
// PDF
// ============================================================

export async function createInvoicePdf(
  input: {
    order: ShopifyOrderForInvoice;
    invoiceNumber: string;
  }
): Promise<Buffer> {

  const {
    order,
    invoiceNumber,
  } = input;

  const pdf =
    await PDFDocument.create();

  const font =
    await pdf.embedFont(
      StandardFonts.Helvetica
    );

  const bold =
    await pdf.embedFont(
      StandardFonts.HelveticaBold
    );

  const moduleDir =
    dirname(
      fileURLToPath(
        import.meta.url
      )
    );

  const logoPath =
    resolve(
      moduleDir,
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

  const currency =
    currencyOf(order);

  const subtotal =
    moneyValue(
      order.subtotalPriceSet
    );

  const discounts =
    moneyValue(
      order.totalDiscountsSet
    );

  const shipping =
    moneyValue(
      order.totalShippingPriceSet
    );

  const tax =
    moneyValue(
      order.totalTaxSet
    );

  const total =
    moneyValue(
      order.totalPriceSet
    );

  const billing =
    addressLines(
      order.billingAddress ||
      order.shippingAddress
    );

  const items =
    (
      order
        .lineItems
        ?.edges ??
      []
    )
      .map(
        (edge) =>
          edge?.node
      )
      .filter(
        (
          item
        ): item is ShopifyInvoiceLineItem =>
          Boolean(item)
      );

  let page =
    pdf.addPage([
      PAGE_WIDTH,
      PAGE_HEIGHT,
    ]);

  let y =
    PAGE_HEIGHT - 48;

  const drawHeader = () => {

    page.drawImage(
      logo,
      {
        x: MARGIN_X,
        y:
          PAGE_HEIGHT -
          132,
        width: 84,
        height: 84,
      }
    );

    page.drawText(
      "RECHNUNG",
      {
        x: 400,
        y:
          PAGE_HEIGHT -
          68,
        size: 20,
        font: bold,
        color: BLACK,
      }
    );

    page.drawText(
      invoiceNumber,
      {
        x: 400,
        y:
          PAGE_HEIGHT -
          90,
        size: 10,
        font,
        color: GREY,
      }
    );

    page.drawText(
      formatDate(
        order.createdAt
      ),
      {
        x: 400,
        y:
          PAGE_HEIGHT -
          106,
        size: 9,
        font,
        color: GREY,
      }
    );

    drawLine(
      page,
      PAGE_HEIGHT - 150
    );

    y =
      PAGE_HEIGHT -
      178;
  };

  drawHeader();


  // ==========================================================
  // RECHNUNGSADRESSE
  // ==========================================================

  page.drawText(
    "RECHNUNGSADRESSE",
    {
      x: MARGIN_X,
      y,
      size: 9,
      font: bold,
      color: GREY,
    }
  );

  y -= 20;

  if (
    billing.length === 0
  ) {
    page.drawText(
      "Keine Rechnungsadresse hinterlegt",
      {
        x: MARGIN_X,
        y,
        size: 10,
        font,
        color: BLACK,
      }
    );

    y -= 16;
  } else {
    for (
      const line
      of billing
    ) {
      page.drawText(
        truncateText(
          line,
          font,
          10,
          240
        ),
        {
          x: MARGIN_X,
          y,
          size: 10,
          font,
          color: BLACK,
        }
      );

      y -= 15;
    }
  }

  if (order.email) {
    y -= 2;

    page.drawText(
      truncateText(
        order.email,
        font,
        9,
        260
      ),
      {
        x: MARGIN_X,
        y,
        size: 9,
        font,
        color: GREY,
      }
    );

    y -= 15;
  }

  y -= 16;

  page.drawText(
    `Bestellung: ${cleanText(order.name)}`,
    {
      x: MARGIN_X,
      y,
      size: 10,
      font: bold,
      color: BLACK,
    }
  );

  y -= 26;

  drawLine(
    page,
    y
  );

  y -= 24;


  // ==========================================================
  // TABLE HEADER
  // ==========================================================

  const drawTableHeader =
    () => {

      page.drawText(
        "ARTIKEL",
        {
          x: MARGIN_X,
          y,
          size: 8,
          font: bold,
          color: GREY,
        }
      );

      page.drawText(
        "MENGE",
        {
          x: 350,
          y,
          size: 8,
          font: bold,
          color: GREY,
        }
      );

      page.drawText(
        "PREIS",
        {
          x: 405,
          y,
          size: 8,
          font: bold,
          color: GREY,
        }
      );

      page.drawText(
        "TOTAL",
        {
          x: 493,
          y,
          size: 8,
          font: bold,
          color: GREY,
        }
      );

      y -= 12;

      drawLine(
        page,
        y
      );

      y -= 18;
    };

  drawTableHeader();


  // ==========================================================
  // ITEMS
  // ==========================================================

  for (
    const item
    of items
  ) {

    if (y < 155) {

      page =
        pdf.addPage([
          PAGE_WIDTH,
          PAGE_HEIGHT,
        ]);

      drawHeader();

      page.drawText(
        `Rechnung ${invoiceNumber} – Fortsetzung`,
        {
          x: MARGIN_X,
          y,
          size: 9,
          font: bold,
          color: GREY,
        }
      );

      y -= 25;

      drawTableHeader();
    }

    const quantity =
      Math.max(
        1,
        Number(
          item.quantity ??
          1
        )
      );

    const unitPrice =
      moneyValue(
        item
          .discountedUnitPriceSet
      ) ||
      moneyValue(
        item
          .originalUnitPriceSet
      );

    const lineTotal =
      unitPrice *
      quantity;

    const name =
      truncateText(
        cleanText(
          item.name ||
          "Artikel"
        ),
        font,
        9.5,
        275
      );

    page.drawText(
      name,
      {
        x: MARGIN_X,
        y,
        size: 9.5,
        font,
        color: BLACK,
      }
    );

    if (item.sku) {
      page.drawText(
        truncateText(
          `SKU ${item.sku}`,
          font,
          7.5,
          270
        ),
        {
          x: MARGIN_X,
          y: y - 12,
          size: 7.5,
          font,
          color: GREY,
        }
      );
    }

    page.drawText(
      String(quantity),
      {
        x: 362,
        y,
        size: 9.5,
        font,
        color: BLACK,
      }
    );

    page.drawText(
      formatMoney(
        unitPrice,
        currency
      ),
      {
        x: 405,
        y,
        size: 9,
        font,
        color: BLACK,
      }
    );

    page.drawText(
      formatMoney(
        lineTotal,
        currency
      ),
      {
        x: 485,
        y,
        size: 9,
        font: bold,
        color: BLACK,
      }
    );

    y -= 32;
  }


  // ==========================================================
  // TOTALS
  // ==========================================================

  if (y < 230) {

    page =
      pdf.addPage([
        PAGE_WIDTH,
        PAGE_HEIGHT,
      ]);

    drawHeader();
  }

  y -= 5;

  drawLine(
    page,
    y
  );

  y -= 26;

  const totalXLabel =
    355;

  const totalXValue =
    465;

  const drawTotalRow =
    (
      label: string,
      value: number,
      strong = false
    ) => {

      page.drawText(
        label,
        {
          x: totalXLabel,
          y,
          size:
            strong
              ? 11
              : 9,
          font:
            strong
              ? bold
              : font,
          color: BLACK,
        }
      );

      page.drawText(
        formatMoney(
          value,
          currency
        ),
        {
          x: totalXValue,
          y,
          size:
            strong
              ? 11
              : 9,
          font:
            strong
              ? bold
              : font,
          color: BLACK,
        }
      );

      y -=
        strong
          ? 22
          : 17;
    };

  drawTotalRow(
    "Zwischensumme",
    subtotal
  );

  if (discounts > 0) {
    drawTotalRow(
      "Rabatt",
      -discounts
    );
  }

  drawTotalRow(
    "Versand",
    shipping
  );

  drawTotalRow(
    "MwSt.",
    tax
  );

  y -= 3;

  drawTotalRow(
    "GESAMT",
    total,
    true
  );


  // ==========================================================
  // FOOTER
  // ==========================================================

  const footerY = 62;

  drawLine(
    page,
    footerY + 30
  );

  page.drawText(
    "Vielen Dank für deine Bestellung.",
    {
      x: MARGIN_X,
      y:
        footerY +
        10,
      size: 9,
      font: bold,
      color: BLACK,
    }
  );

  page.drawText(
    "ALO KIOSK · Zwischen den Toren 14 · 5000 Aarau · alokiosk.ch",
    {
      x: MARGIN_X,
      y:
        footerY -
        7,
      size: 8,
      font,
      color: GREY,
    }
  );

  return Buffer.from(
    await pdf.save()
  );
}


// ============================================================
// CREATE / ARCHIVE INVOICE
// ============================================================

export async function createInvoiceForOrder(
  order: ShopifyOrderForInvoice
) {

  if (!order?.id) {
    throw new Error(
      "Shopify Order ID fehlt."
    );
  }

  if (!order?.name) {
    throw new Error(
      "Shopify Bestellnummer fehlt."
    );
  }

  const currency =
    currencyOf(order);

  const subtotal =
    moneyValue(
      order.subtotalPriceSet
    );

  const discount =
    moneyValue(
      order.totalDiscountsSet
    );

  const shipping =
    moneyValue(
      order.totalShippingPriceSet
    );

  const tax =
    moneyValue(
      order.totalTaxSet
    );

  const total =
    moneyValue(
      order.totalPriceSet
    );

  const orderCreatedAt =
    order.createdAt
      ? new Date(
          order.createdAt
        )
      : null;

  const reservation =
    await reserveInvoice({
      shopifyOrderId:
        order.id,

      shopifyOrderName:
        order.name,

      orderCreatedAt:
        orderCreatedAt &&
        !Number.isNaN(
          orderCreatedAt.getTime()
        )
          ? orderCreatedAt
          : null,

      currency,

      subtotalAmount:
        subtotal.toFixed(2),

      discountAmount:
        discount.toFixed(2),

      shippingAmount:
        shipping.toFixed(2),

      taxAmount:
        tax.toFixed(2),

      totalAmount:
        total.toFixed(2),
    });

  if (
    !reservation.created &&
    reservation.record.status ===
      "COMPLETED" &&
    reservation.record.pdf_base64
  ) {
    return {
      id:
        reservation.record.id,
      invoiceNumber:
        reservation.record
          .invoice_number,
      pdfBase64:
        reservation.record
          .pdf_base64,
      reused: true,
    };
  }

  try {

    const pdf =
      await createInvoicePdf({
        order,
        invoiceNumber:
          reservation.record.invoice_number,
      });

    const pdfBase64 =
      pdf.toString(
        "base64"
      );

    const completed =
      await completeInvoice(
        reservation.record.id,
        pdfBase64
      );

    return {
      id:
        completed.id,
      invoiceNumber:
        completed.invoice_number,
      pdfBase64:
        completed.pdf_base64,
      reused: false,
    };

  } catch (error) {

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    try {
      await failInvoice(
        reservation.record.id,
        message
      );
    } catch (
      databaseError
    ) {
      console.error(
        "Rechnungs-Fehlerstatus konnte nicht gespeichert werden:",
        databaseError
      );
    }

    throw new Error(
      `Rechnung für ${order.name} konnte nicht erstellt werden: ${message}`
    );
  }
}

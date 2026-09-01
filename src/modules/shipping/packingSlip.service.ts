import {
  reservePackingSlip,
  completePackingSlip,
} from "../../database/packingSlips.js";

type ShopifyOrder = {
  id: string;
  name: string;
  createdAt?: string;
  email?: string | null;

  totalPriceSet?: {
    shopMoney?: {
      amount?: string;
      currencyCode?: string;
    };
  };

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

// ============================================================
// PDF TEXT
// ============================================================

function escapePdfText(value: string): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

// ============================================================
// SIMPLE A4 PDF
// ============================================================

function createPackingSlipPdf(lines: string[]): string {
  const pageWidth = 595;
  const pageHeight = 842;

  const commands: string[] = [];

  commands.push("BT");
  commands.push("/F1 11 Tf");
  commands.push("50 790 Td");

  let first = true;

  for (const line of lines) {
    if (!first) {
      commands.push("0 -22 Td");
    }

    commands.push(
      `(${escapePdfText(line)}) Tj`
    );

    first = false;
  }

  commands.push("ET");

  const stream = commands.join("\n");

  const objects: string[] = [];

  objects.push(
    "<< /Type /Catalog /Pages 2 0 R >>"
  );

  objects.push(
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"
  );

  objects.push(
    `<< /Type /Page
       /Parent 2 0 R
       /MediaBox [0 0 ${pageWidth} ${pageHeight}]
       /Resources <<
         /Font <<
           /F1 5 0 R
         >>
       >>
       /Contents 4 0 R
    >>`
  );

  objects.push(
    `<< /Length ${Buffer.byteLength(
      stream,
      "utf8"
    )} >>
stream
${stream}
endstream`
  );

  objects.push(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  );

  let pdf = "%PDF-1.4\n";

  const offsets: number[] = [0];

  for (let i = 0; i < objects.length; i++) {
    offsets.push(
      Buffer.byteLength(pdf, "utf8")
    );

    pdf +=
      `${i + 1} 0 obj\n` +
      `${objects[i]}\n` +
      `endobj\n`;
  }

  const xrefOffset =
    Buffer.byteLength(pdf, "utf8");

  pdf += `xref\n`;
  pdf += `0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";

  for (
    let i = 1;
    i <= objects.length;
    i++
  ) {
    pdf +=
      `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }

  pdf +=
    `trailer\n` +
    `<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n` +
    `${xrefOffset}\n` +
    `%%EOF\n`;

  return Buffer
    .from(pdf, "utf8")
    .toString("base64");
}

// ============================================================
// LIEFERSCHEIN ERSTELLEN
// ============================================================

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

  // Bereits vorhanden
  if (
    !reservation.created &&
    reservation.record.status === "COMPLETED" &&
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

  const address =
    order.shippingAddress;

  const total =
    order.totalPriceSet
      ?.shopMoney
      ?.amount ?? "0.00";

  const currency =
    order.totalPriceSet
      ?.shopMoney
      ?.currencyCode ?? "CHF";

  const items =
    (
      order.lineItems?.edges ?? []
    )
      .map(
        (edge) => edge.node
      )
      .filter(Boolean);

  const lines: string[] = [];

  // ----------------------------------------------------------
  // HEADER
  // ----------------------------------------------------------

  lines.push("ALO KIOSK");
  lines.push("ONLINE SHOP");
  lines.push("");
  lines.push("LIEFERSCHEIN");
  lines.push("");
  lines.push(
    `Bestellung: ${order.name}`
  );

  if (order.createdAt) {
    lines.push(
      `Datum: ${new Date(
        order.createdAt
      ).toLocaleDateString("de-CH")}`
    );
  }

  lines.push("");
  lines.push("----------------------------------------");
  lines.push("LIEFERADRESSE");
  lines.push("----------------------------------------");

  if (address) {
    const fullName =
      [
        address.firstName,
        address.lastName,
      ]
        .filter(Boolean)
        .join(" ");

    if (fullName) {
      lines.push(fullName);
    }

    if (address.company) {
      lines.push(address.company);
    }

    if (address.address1) {
      lines.push(address.address1);
    }

    if (address.address2) {
      lines.push(address.address2);
    }

    const location =
      [
        address.zip,
        address.city,
      ]
        .filter(Boolean)
        .join(" ");

    if (location) {
      lines.push(location);
    }

    if (address.country) {
      lines.push(address.country);
    }
  }

  if (order.email) {
    lines.push("");
    lines.push(
      `E-Mail: ${order.email}`
    );
  }

  lines.push("");
  lines.push("----------------------------------------");
  lines.push("ARTIKEL");
  lines.push("----------------------------------------");

  for (const item of items) {
    const name =
      item?.name ??
      "Artikel";

    const quantity =
      item?.quantity ?? 0;

    const sku =
      item?.sku ?? "";

    const variant =
      item?.variant?.title ?? "";

    lines.push(
      `${quantity}x ${name}`
    );

    if (
      variant &&
      variant !== "Default Title"
    ) {
      lines.push(
        `   Variante: ${variant}`
      );
    }

    if (sku) {
      lines.push(
        `   SKU: ${sku}`
      );
    }

    lines.push("");
  }

  lines.push("----------------------------------------");

  lines.push(
    `TOTAL: ${total} ${currency}`
  );

  lines.push("");
  lines.push("");
  lines.push(
    "Vielen Dank für deine Bestellung!"
  );
  lines.push("ALO KIOSK");

  const pdfBase64 =
    createPackingSlipPdf(
      lines
    );

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
  };
}

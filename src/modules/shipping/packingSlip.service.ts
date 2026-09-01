import {
  reservePackingSlip,
  completePackingSlip,
} from "../../database/packingSlips.js";

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

function pdfText(value: unknown): string {
  return String(value ?? "")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function pdfStringLength(value: string): number {
  return Buffer.byteLength(value, "latin1");
}

function formatDate(value?: string): string {
  if (!value) {
    return new Date().toLocaleDateString("de-CH");
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return new Date().toLocaleDateString("de-CH");
  }

  return date.toLocaleDateString("de-CH");
}

function wrapText(
  value: string,
  maxCharacters: number
): string[] {
  const clean = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) {
    return [];
  }

  const words = clean.split(" ");
  const lines: string[] = [];

  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }

    const candidate = `${current} ${word}`;

    if (candidate.length <= maxCharacters) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function textCommand(
  x: number,
  y: number,
  text: string,
  font = "F1",
  size = 10
): string {
  return [
    "BT",
    `/${font} ${size} Tf`,
    `1 0 0 1 ${x} ${y} Tm`,
    `(${pdfText(text)}) Tj`,
    "ET",
  ].join("\n");
}

function lineCommand(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width = 0.7
): string {
  return [
    `${width} w`,
    `${x1} ${y1} m`,
    `${x2} ${y2} l`,
    "S",
  ].join("\n");
}

function filledRectCommand(
  x: number,
  y: number,
  width: number,
  height: number,
  gray = 0.95
): string {
  return [
    `${gray} g`,
    `${x} ${y} ${width} ${height} re`,
    "f",
    "0 g",
  ].join("\n");
}

/* =========================================================
   A4 PACKING SLIP PDF
========================================================= */

export function createPackingSlipPdf(input: {
  orderName: string;
  date: string;
  email?: string | null;
  addressLines: string[];
  items: Array<{
    quantity: number;
    name: string;
    sku: string;
    variant: string;
  }>;
}): string {
  const pageWidth = 595;
  const pageHeight = 842;

  const left = 48;
  const right = 547;
  const contentWidth = right - left;

  const commands: string[] = [];

  /* -------------------------------------------------------
     HEADER
  ------------------------------------------------------- */

  commands.push(
    textCommand(
      left,
      790,
      "ALO KIOSK",
      "F2",
      22
    )
  );

  commands.push(
    textCommand(
      left,
      771,
      "ONLINE SHOP",
      "F1",
      9
    )
  );

  commands.push(
    textCommand(
      398,
      790,
      "LIEFERSCHEIN",
      "F2",
      17
    )
  );

  commands.push(
    textCommand(
      398,
      768,
      `Bestellung ${input.orderName}`,
      "F1",
      9
    )
  );

  commands.push(
    textCommand(
      398,
      753,
      input.date,
      "F1",
      9
    )
  );

  commands.push(
    lineCommand(
      left,
      730,
      right,
      730,
      1.2
    )
  );

  /* -------------------------------------------------------
     ADDRESS
  ------------------------------------------------------- */

  commands.push(
    textCommand(
      left,
      700,
      "LIEFERADRESSE",
      "F2",
      10
    )
  );

  let y = 678;

  for (const addressLine of input.addressLines) {
    commands.push(
      textCommand(
        left,
        y,
        addressLine,
        "F1",
        10
      )
    );

    y -= 16;
  }

  if (input.email) {
    y -= 5;

    commands.push(
      textCommand(
        left,
        y,
        `E-Mail: ${input.email}`,
        "F1",
        9
      )
    );

    y -= 16;
  }

  y -= 25;

  /* -------------------------------------------------------
     ITEMS TITLE
  ------------------------------------------------------- */

  commands.push(
    textCommand(
      left,
      y,
      "BESTELLUNG",
      "F2",
      11
    )
  );

  y -= 23;

  /* -------------------------------------------------------
     TABLE HEADER
  ------------------------------------------------------- */

  commands.push(
    filledRectCommand(
      left,
      y - 7,
      contentWidth,
      25,
      0.94
    )
  );

  commands.push(
    textCommand(
      left + 8,
      y,
      "MENGE",
      "F2",
      8
    )
  );

  commands.push(
    textCommand(
      left + 68,
      y,
      "ARTIKEL",
      "F2",
      8
    )
  );

  commands.push(
    textCommand(
      458,
      y,
      "SKU",
      "F2",
      8
    )
  );

  y -= 28;

  /* -------------------------------------------------------
     ITEMS
  ------------------------------------------------------- */

  for (const item of input.items) {
    if (y < 120) {
      commands.push(
        textCommand(
          left,
          y,
          "Weitere Artikel siehe Bestelldaten.",
          "F1",
          9
        )
      );

      y -= 20;
      break;
    }

    const nameLines =
      wrapText(item.name, 45);

    commands.push(
      textCommand(
        left + 8,
        y,
        String(item.quantity),
        "F2",
        10
      )
    );

    let itemY = y;

    for (const nameLine of nameLines) {
      commands.push(
        textCommand(
          left + 68,
          itemY,
          nameLine,
          "F1",
          10
        )
      );

      itemY -= 14;
    }

    if (item.sku) {
      const skuLines =
        wrapText(item.sku, 16);

      let skuY = y;

      for (const skuLine of skuLines) {
        commands.push(
          textCommand(
            458,
            skuY,
            skuLine,
            "F1",
            8
          )
        );

        skuY -= 12;
      }
    }

    let rowBottom =
      Math.min(
        itemY,
        y - 14
      );

    if (
      item.variant &&
      item.variant !== "Default Title"
    ) {
      commands.push(
        textCommand(
          left + 68,
          rowBottom,
          `Variante: ${item.variant}`,
          "F1",
          8
        )
      );

      rowBottom -= 13;
    }

    y = rowBottom - 8;

    commands.push(
      lineCommand(
        left,
        y,
        right,
        y,
        0.3
      )
    );

    y -= 17;
  }

  /* -------------------------------------------------------
     SHIPPING
  ------------------------------------------------------- */

  if (y > 125) {
    y -= 7;

    commands.push(
      textCommand(
        left,
        y,
        "VERSAND",
        "F2",
        9
      )
    );

    y -= 17;

    commands.push(
      textCommand(
        left,
        y,
        "Versand mit der Schweizerischen Post",
        "F1",
        9
      )
    );
  }

  /* -------------------------------------------------------
     FOOTER
  ------------------------------------------------------- */

  commands.push(
    lineCommand(
      left,
      75,
      right,
      75,
      0.7
    )
  );

  commands.push(
    textCommand(
      left,
      56,
      "ALO KIOSK  |  Zwischen den Toren 14  |  5000 Aarau",
      "F1",
      8
    )
  );

  commands.push(
    textCommand(
      left,
      40,
      "Vielen Dank fuer deine Bestellung.",
      "F1",
      8
    )
  );

  /* =======================================================
     PDF STRUCTURE
  ======================================================= */

  const stream = commands.join("\n");

  const objects: string[] = [];

  objects.push(
    "<< /Type /Catalog /Pages 2 0 R >>"
  );

  objects.push(
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"
  );

  objects.push(
    `<<
      /Type /Page
      /Parent 2 0 R
      /MediaBox [0 0 ${pageWidth} ${pageHeight}]
      /Resources <<
        /Font <<
          /F1 5 0 R
          /F2 6 0 R
        >>
      >>
      /Contents 4 0 R
    >>`
  );

  objects.push(
    `<< /Length ${pdfStringLength(stream)} >>
stream
${stream}
endstream`
  );

  objects.push(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
  );

  objects.push(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
  );

  let pdf = "%PDF-1.4\n";

  const offsets: number[] = [0];

  for (
    let index = 0;
    index < objects.length;
    index++
  ) {
    offsets.push(
      Buffer.byteLength(
        pdf,
        "latin1"
      )
    );

    pdf +=
      `${index + 1} 0 obj\n` +
      `${objects[index]}\n` +
      "endobj\n";
  }

  const xrefOffset =
    Buffer.byteLength(
      pdf,
      "latin1"
    );

  pdf += "xref\n";
  pdf +=
    `0 ${objects.length + 1}\n`;

  pdf +=
    "0000000000 65535 f \n";

  for (
    let index = 1;
    index <= objects.length;
    index++
  ) {
    pdf +=
      `${String(
        offsets[index]
      ).padStart(
        10,
        "0"
      )} 00000 n \n`;
  }

  pdf +=
    "trailer\n" +
    `<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    "startxref\n" +
    `${xrefOffset}\n` +
    "%%EOF\n";

  return Buffer
    .from(
      pdf,
      "latin1"
    )
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
    createPackingSlipPdf({
      orderName: order.name,
      date: formatDate(
        order.createdAt
      ),
      email: order.email,
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
  };
}

import {
  reserveShippingLabel,
  completeShippingLabel,
  failShippingLabel,
} from "../../database/shippingLabels.js";


// ============================================================
// TYPES
// ============================================================

type PickupOrder = {
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

  lineItems?: {
    edges?: Array<{
      node?: {
        id?: string;
        name?: string;
        quantity?: number;
        sku?: string | null;

        variant?: {
          id?: string;
          title?: string | null;
        } | null;
      };
    }>;
  };
};


// ============================================================
// PDF ESCAPING
// ============================================================

function escapePdfText(
  value: string
): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}


// ============================================================
// SIMPLE PDF GENERATOR
//
// Bewusst ohne zusätzliche npm-Abhängigkeit.
// Der Print-Agent bekommt ein normales PDF.
// ============================================================

function createSimplePdf(
  lines: string[]
): string {

  const pageWidth = 595;
  const pageHeight = 842;

  const commands: string[] = [];

  commands.push(
    "BT"
  );

  commands.push(
    "/F1 24 Tf"
  );

  commands.push(
    "50 790 Td"
  );

  let first = true;

  for (const line of lines) {

    if (!first) {
      commands.push(
        "0 -32 Td"
      );
    }

    commands.push(
      `(${escapePdfText(line)}) Tj`
    );

    first = false;
  }

  commands.push(
    "ET"
  );

  const stream =
    commands.join("\n");

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


  let pdf =
    "%PDF-1.4\n";

  const offsets: number[] = [
    0,
  ];

  for (
    let i = 0;
    i < objects.length;
    i++
  ) {

    offsets.push(
      Buffer.byteLength(
        pdf,
        "utf8"
      )
    );

    pdf +=
      `${i + 1} 0 obj\n` +
      `${objects[i]}\n` +
      `endobj\n`;
  }

  const xrefOffset =
    Buffer.byteLength(
      pdf,
      "utf8"
    );

  pdf +=
    `xref\n` +
    `0 ${objects.length + 1}\n`;

  pdf +=
    "0000000000 65535 f \n";

  for (
    let i = 1;
    i <= objects.length;
    i++
  ) {

    pdf +=
      `${String(
        offsets[i]
      ).padStart(10, "0")} 00000 n \n`;
  }

  pdf +=
    `trailer\n` +
    `<< /Size ${
      objects.length + 1
    } /Root 1 0 R >>\n` +
    `startxref\n` +
    `${xrefOffset}\n` +
    `%%EOF\n`;

  return Buffer
    .from(pdf, "utf8")
    .toString("base64");
}


// ============================================================
// ABHOLBON ERSTELLEN
// ============================================================

export async function createPickupReceiptForOrder(
  order: PickupOrder
) {

  if (!order?.id) {
    throw new Error(
      "Pickup Bestellung hat keine Shopify Order ID."
    );
  }

  if (!order?.name) {
    throw new Error(
      "Pickup Bestellung hat keinen Bestellnamen."
    );
  }


  // ----------------------------------------------------------
  // RESERVIERUNG
  //
  // Wir benutzen dieselbe shipping_labels Infrastruktur,
  // damit die bestehende Print Queue weiter funktioniert.
  // ----------------------------------------------------------

  const reservation =
    await reserveShippingLabel({
      shopifyOrderId:
        order.id,

      shopifyOrderName:
        order.name,

      mode:
        "PICKUP",

      service:
        "PICKUP",

      weightGrams:
        0,

      addressQuality:
        "NOT_REQUIRED",
    });


  // ----------------------------------------------------------
  // BEREITS FERTIG
  // ----------------------------------------------------------

  if (
    !reservation.created &&
    reservation.record.status ===
      "COMPLETED" &&
    reservation.record.label_pdf_base64
  ) {

    return {
      reused: true,

      labelId:
        reservation.record.id,

      pdfBase64:
        reservation.record
          .label_pdf_base64,
    };
  }


  // ----------------------------------------------------------
  // WIRD BEREITS VERARBEITET
  // ----------------------------------------------------------

  if (
    !reservation.created &&
    reservation.record.status ===
      "RESERVED"
  ) {

    throw new Error(
      `Abholbon für ${order.name} wird bereits verarbeitet.`
    );
  }


  try {

    const total =
      order
        .totalPriceSet
        ?.shopMoney
        ?.amount ??
      "0.00";

    const currency =
      order
        .totalPriceSet
        ?.shopMoney
        ?.currencyCode ??
      "CHF";


    const items =
      (
        order.lineItems
          ?.edges ??
        []
      )
        .map(
          (edge) =>
            edge.node
        )
        .filter(Boolean);


    const lines: string[] = [];


    // --------------------------------------------------------
    // HEADER
    // --------------------------------------------------------

    lines.push(
      "ALO KIOSK"
    );

    lines.push(
      "ABHOLBESTELLUNG"
    );

    lines.push(
      ""
    );

    lines.push(
      `BESTELLUNG ${order.name}`
    );

    lines.push(
      ""
    );


    // --------------------------------------------------------
    // PRODUKTE
    // --------------------------------------------------------

    for (
      const item of items
    ) {

      const quantity =
        Number(
          item?.quantity ??
          0
        );

      const name =
        String(
          item?.name ??
          "Produkt"
        );

      lines.push(
        `${quantity}x ${name}`
      );
    }


    // --------------------------------------------------------
    // TOTAL
    // --------------------------------------------------------

    lines.push(
      ""
    );

    lines.push(
      `TOTAL ${currency} ${total}`
    );

    lines.push(
      ""
    );

    lines.push(
      "BEZAHLT"
    );

    lines.push(
      ""
    );

    lines.push(
      "ABHOLBEREIT"
    );

    lines.push(
      ""
    );

    lines.push(
      "Bitte Bestellung am"
    );

    lines.push(
      "ALO KIOSK abholen."
    );


    const pdfBase64 =
      createSimplePdf(
        lines
      );


    // --------------------------------------------------------
    // IN DATABASE SPEICHERN
    // --------------------------------------------------------

    await completeShippingLabel(
      reservation.record.id,
      {
        identCode:
          null,

        pdfBase64,
      }
    );


    return {

      reused: false,

      labelId:
        reservation.record.id,

      pdfBase64,
    };

  } catch (
    error: any
  ) {

    await failShippingLabel(
      reservation.record.id,
      error?.message ??
        String(error)
    );

    throw error;
  }
}

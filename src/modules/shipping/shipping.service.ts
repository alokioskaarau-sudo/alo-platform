import {
  reserveShippingLabel,
  completeShippingLabel,
  failShippingLabel,
} from "../../database/shippingLabels.js";

import { validateSwissPostAddress } from "../../integrations/swisspost/address.js";
import { createSwissPostPreviewLabel } from "../../integrations/swisspost/label.js";

import {
  splitSwissStreetAddress,
} from "./shopifyShipping.js";

type WeightUnit =
  | "GRAMS"
  | "KILOGRAMS"
  | "OUNCES"
  | "POUNDS";

type ShopifyOrder = {
  id: string;
  name: string;
  displayFinancialStatus: string;

  shippingAddress?: {
    firstName?: string | null;
    lastName?: string | null;
    address1?: string | null;
    zip?: string | null;
    city?: string | null;
    countryCodeV2?: string | null;
  } | null;

  lineItems?: {
    edges?: Array<{
      node: {
        quantity: number;

        weight?: {
          value: number;
          unit: WeightUnit;
        } | null;
      };
    }>;
  };
};


// ============================================================
// WEIGHT HELPERS
// ============================================================

function convertWeightToGrams(
  value: number,
  unit: WeightUnit
): number {
  switch (unit) {
    case "GRAMS":
      return value;

    case "KILOGRAMS":
      return value * 1000;

    case "OUNCES":
      return value * 28.3495;

    case "POUNDS":
      return value * 453.592;

    default:
      throw new Error(
        `Unbekannte Gewichtseinheit: ${unit}`
      );
  }
}


function calculateOrderWeightGrams(
  order: ShopifyOrder
): number {
  const edges =
    order.lineItems?.edges ?? [];

  if (edges.length === 0) {
    throw new Error(
      "Bestellung enthält keine Produkte."
    );
  }

  let productsWeightGrams = 0;

  for (const edge of edges) {
    const item = edge.node;

    if (
      !item.weight ||
      typeof item.weight.value !== "number"
    ) {
      throw new Error(
        "Bei mindestens einem Produkt fehlt das Shopify-Gewicht."
      );
    }

    const singleItemGrams =
      convertWeightToGrams(
        item.weight.value,
        item.weight.unit
      );

    productsWeightGrams +=
      singleItemGrams *
      item.quantity;
  }

  // Verpackung / Karton / Füllmaterial
  const packagingWeightGrams = 250;

  const total =
    productsWeightGrams +
    packagingWeightGrams;

  // Auf ganze Gramm aufrunden
  return Math.ceil(total);
}


// ============================================================
// SPECIMEN LABEL
// ============================================================

export async function createSpecimenLabelForOrder(
  order: ShopifyOrder
) {
  if (
    order.displayFinancialStatus !== "PAID"
  ) {
    throw new Error(
      `Bestellung ${order.name} ist nicht bezahlt.`
    );
  }

  if (!order.shippingAddress) {
    throw new Error(
      `Bestellung ${order.name} hat keine Versandadresse.`
    );
  }

  const address =
    order.shippingAddress;

  if (
    !address.firstName ||
    !address.lastName ||
    !address.address1 ||
    !address.zip ||
    !address.city
  ) {
    throw new Error(
      "Versandadresse ist unvollständig."
    );
  }

  if (
    address.countryCodeV2 &&
    address.countryCodeV2 !== "CH"
  ) {
    throw new Error(
      "Aktuell werden nur Schweizer Adressen unterstützt."
    );
  }


  // ----------------------------------------------------------
  // Strasse + Hausnummer
  // ----------------------------------------------------------

  const {
    street,
    houseNumber,
  } = splitSwissStreetAddress(
    address.address1
  );


  // ----------------------------------------------------------
  // Swiss Post Adresse prüfen
  // ----------------------------------------------------------

  const validation =
    await validateSwissPostAddress({
      firstName:
        address.firstName,

      lastName:
        address.lastName,

      street,
      houseNumber,

      zip:
        address.zip,

      city:
        address.city,
    });


  const acceptedQualities = [
    "CERTIFIED",
    "DOMICILE_CERTIFIED",
  ];

  if (
    !validation?.quality ||
    !acceptedQualities.includes(
      validation.quality
    )
  ) {
    throw new Error(
      `Adresse nicht ausreichend bestätigt: ${
        validation?.quality ??
        "UNKNOWN"
      }`
    );
  }


  // ----------------------------------------------------------
  // Gewicht automatisch aus Shopify
  // ----------------------------------------------------------

  const weightGrams =
    calculateOrderWeightGrams(
      order
    );

  console.log(
    `Berechnetes Versandgewicht ${order.name}: ${weightGrams} g`
  );


  // ----------------------------------------------------------
  // PostgreSQL Reservation
  // ----------------------------------------------------------

  const reservation =
    await reserveShippingLabel({
      shopifyOrderId:
        order.id,

      shopifyOrderName:
        order.name,

      mode:
        "SPECIMEN",

      service:
        "ECO",

      weightGrams,

      addressQuality:
        validation.quality,
    });


  // ----------------------------------------------------------
  // Bereits fertig?
  // ----------------------------------------------------------

  if (
    !reservation.created &&
    reservation.record.status ===
      "COMPLETED" &&
    reservation.record.label_pdf_base64
  ) {
    return {
      reused: true,

      identCode:
        reservation.record
          .swisspost_ident_code,

      pdfBase64:
        reservation.record
          .label_pdf_base64,

      weightGrams:
        reservation.record
          .weight_grams ??
        weightGrams,
    };
  }


  // ----------------------------------------------------------
  // Wird bereits verarbeitet?
  // ----------------------------------------------------------

  if (
    !reservation.created &&
    reservation.record.status ===
      "RESERVED"
  ) {
    throw new Error(
      "Label wird bereits verarbeitet."
    );
  }


  try {
    const numericOrderId =
      String(order.id).replace(
        "gid://shopify/Order/",
        ""
      );

    const itemId =
      `ALO-${numericOrderId}`;

    const recipientName =
      `${address.firstName} ${address.lastName}`.trim();


    // --------------------------------------------------------
    // Swiss Post Label
    // --------------------------------------------------------

    const labelResult =
      await createSwissPostPreviewLabel({
        itemId,

        recipient: {
          name1:
            recipientName,

          street,

          houseNo:
            houseNumber,

          zip:
            address.zip,

          city:
            address.city,

          country:
            "CH",
        },

        weightGrams,

        service:
          "ECO",
      });


    const pdfBase64 =
      labelResult?.item?.label?.[0];

    const identCode =
      labelResult?.item?.identCode;

    if (
      !pdfBase64 ||
      !identCode
    ) {
      throw new Error(
        "Swiss Post hat kein vollständiges Label geliefert."
      );
    }


    // --------------------------------------------------------
    // In PostgreSQL speichern
    // --------------------------------------------------------

    await completeShippingLabel(
      reservation.record.id,
      {
        identCode,
        pdfBase64,
      }
    );


    return {
      reused: false,
      identCode,
      pdfBase64,
      weightGrams,
    };

  } catch (error: any) {
    await failShippingLabel(
      reservation.record.id,
      error.message
    );

    throw error;
  }
}

import axios from "axios";
import { env } from "../../config/env.js";
import { getSwissPostAccessToken } from "./auth.js";

export type CreateLabelInput = {
  itemId: string;
  recipient: {
    name1: string;
    name2?: string;
    street: string;
    houseNo: string;
    zip: string;
    city: string;
    country?: string;
  };
  weightGrams: number;
  service?: "ECO" | "PRI";
};

export async function createSwissPostPreviewLabel(
  input: CreateLabelInput
) {
  const token = await getSwissPostAccessToken();

  const recipient: {
    name1: string;
    name2?: string;
    street: string;
    houseNo: string;
    zip: string;
    city: string;
    country: string;
  } = {
    name1: input.recipient.name1,
    street: input.recipient.street,
    houseNo: input.recipient.houseNo,
    zip: input.recipient.zip,
    city: input.recipient.city,
    country: input.recipient.country || "CH",
  };

  if (
    input.recipient.name2 &&
    input.recipient.name2.trim().length > 0
  ) {
    recipient.name2 = input.recipient.name2.trim();
  }

  const payload = {
    language: "DE",
    frankingLicense: env.swissPost.frankingLicense,

    customer: {
      name1: "ALO Kiosk",
      street: "Zielempgasse 17",
      zip: "4600",
      city: "Olten",
      domicilePostOffice: "4600 Olten",
      country: "CH",
    },

    labelDefinition: {
      labelLayout: "A6",
      printAddresses: "RECIPIENT_AND_CUSTOMER",
      imageFileType: "PDF",
      imageResolution: 300,
      printPreview: false,
    },

    item: {
      itemID: input.itemId,
      recipient: recipient,

      attributes: {
        przl: [input.service || "ECO"],
        weight: input.weightGrams,
      },
    },
  };

  const response = await axios.post(
    `${env.swissPost.barcodeBaseUrl}/generateAddressLabel`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 20000,
      validateStatus: () => true,
    }
  );

  console.log("Swiss Post Barcode HTTP:", response.status);

  if (response.status >= 400) {
    console.log(
      "Swiss Post Barcode Response:",
      JSON.stringify(response.data, null, 2)
    );

    throw new Error(
      `Swiss Post label generation failed (${response.status})`
    );
  }

  console.log("Swiss Post Label erfolgreich erstellt.");

  return response.data;
}

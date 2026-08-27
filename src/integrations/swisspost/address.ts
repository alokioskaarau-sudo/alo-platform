import axios from "axios";
import { env } from "../../config/env.js";
import { getSwissPostAccessToken } from "./auth.js";

export type SwissPostAddressInput = {
  firstName: string;
  lastName: string;
  street: string;
  houseNumber: string;
  zip: string;
  city: string;
};

export async function validateSwissPostAddress(
  address: SwissPostAddressInput
) {
  const token = await getSwissPostAccessToken();

  const payload = {
    addressee: {
      firstName: address.firstName,
      lastName: address.lastName,
    },
    geographicLocation: {
      house: {
        street: address.street,
        houseNumber: address.houseNumber,
        additionalAddress: "",
      },
      zip: {
        zip: address.zip,
        city: address.city,
      },
    },
    logisticLocation: {
      postBoxNumber: "",
    },
    fullValidation: true,
  };

  try {
    const response = await axios.post(
      `${env.swissPost.addressBaseUrl}/addresses/validation`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    return response.data;
  } catch (error: any) {
    console.error(
      "Swiss Post Address Fehler:",
      error.response?.status,
      error.response?.data
    );

    throw new Error(
      `Swiss Post address validation failed${
        error.response?.status ? ` (${error.response.status})` : ""
      }`
    );
  }
}

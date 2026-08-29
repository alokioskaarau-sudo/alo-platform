import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

const BACKEND_URL =
  "https://alo-platform-production.up.railway.app";

export async function action({
  request,
}: ActionFunctionArgs) {
  await authenticate.admin(request);

  if (request.method !== "POST") {
    return Response.json(
      {
        ok: false,
        error: "Nur POST ist erlaubt.",
      },
      { status: 405 },
    );
  }

  try {
    const response = await fetch(
      `${BACKEND_URL}/api/printer-pairing/create`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );

    const data = await response.json();

    return Response.json(data, {
      status: response.status,
    });
  } catch (error) {
    console.error(
      "Printer pairing backend error:",
      error,
    );

    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Railway Backend nicht erreichbar.",
      },
      { status: 502 },
    );
  }
}

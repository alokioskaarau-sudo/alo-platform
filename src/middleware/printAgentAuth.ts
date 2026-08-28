import type {
  NextFunction,
  Request,
  Response,
} from "express";

import {
  timingSafeEqual,
} from "node:crypto";


function safeEqual(
  received: string,
  expected: string
): boolean {
  const receivedBuffer =
    Buffer.from(
      received,
      "utf8"
    );

  const expectedBuffer =
    Buffer.from(
      expected,
      "utf8"
    );

  if (
    receivedBuffer.length !==
    expectedBuffer.length
  ) {
    return false;
  }

  return timingSafeEqual(
    receivedBuffer,
    expectedBuffer
  );
}


export function requirePrintAgentToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const expectedToken =
    process.env.PRINT_AGENT_TOKEN;

  if (!expectedToken) {
    console.error(
      "PRINT_AGENT_TOKEN ist auf dem Server nicht konfiguriert."
    );

    return res
      .status(503)
      .json({
        ok: false,
        error:
          "Print Agent ist nicht konfiguriert.",
      });
  }


  const authorization =
    req.get("Authorization");

  let receivedToken = "";


  // Unterstützt:
  // Authorization: Bearer TOKEN

  if (
    authorization?.startsWith(
      "Bearer "
    )
  ) {
    receivedToken =
      authorization
        .slice(7)
        .trim();
  }


  // Zusätzlich möglich:
  // X-Print-Agent-Token: TOKEN

  if (!receivedToken) {
    receivedToken =
      req
        .get(
          "X-Print-Agent-Token"
        )
        ?.trim() ??
      "";
  }


  if (
    !receivedToken ||
    !safeEqual(
      receivedToken,
      expectedToken
    )
  ) {
    console.warn(
      "Nicht autorisierter Print-Agent-Zugriff abgelehnt."
    );

    return res
      .status(401)
      .json({
        ok: false,
        error:
          "Unauthorized",
      });
  }


  return next();
}

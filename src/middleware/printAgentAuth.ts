import type {
  NextFunction,
  Request,
  Response,
} from "express";

import {
  createHash,
  timingSafeEqual,
} from "node:crypto";

import {
  db,
} from "../database/db.js";


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


function hashToken(
  token: string
): string {
  return createHash("sha256")
    .update(token)
    .digest("hex");
}


function getReceivedToken(
  req: Request
): string {
  const authorization =
    req.get("Authorization");

  if (
    authorization?.startsWith(
      "Bearer "
    )
  ) {
    return authorization
      .slice(7)
      .trim();
  }

  return (
    req
      .get(
        "X-Print-Agent-Token"
      )
      ?.trim() ?? ""
  );
}


export async function requirePrintAgentToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const receivedToken =
      getReceivedToken(req);

    if (!receivedToken) {
      console.warn(
        "Print-Agent-Zugriff ohne Token abgelehnt."
      );

      return res
        .status(401)
        .json({
          ok: false,
          error:
            "Unauthorized",
        });
    }


    /*
     * 1. Neuer Weg:
     *    individueller Device-Token
     */
    const tokenHash =
      hashToken(
        receivedToken
      );

    const deviceResult =
      await db.query(
        `
          SELECT
            id,
            device_id,
            device_name,
            platform,
            agent_version,
            status
          FROM printer_devices
          WHERE token_hash = $1
          LIMIT 1
        `,
        [tokenHash]
      );

    if (
      deviceResult.rows.length > 0
    ) {
      const device =
        deviceResult.rows[0];

      await db.query(
        `
          UPDATE printer_devices
          SET
            status = 'ONLINE',
            last_seen_at = NOW(),
            updated_at = NOW()
          WHERE id = $1
        `,
        [device.id]
      );

      res.locals.printDevice =
        device;

      return next();
    }


    /*
     * 2. Übergangs-Fallback:
     *    alter gemeinsamer PRINT_AGENT_TOKEN
     *
     *    Den entfernen wir später,
     *    sobald der neue Connector
     *    vollständig funktioniert.
     */
    const legacyToken =
      process.env
        .PRINT_AGENT_TOKEN;

    if (
      legacyToken &&
      safeEqual(
        receivedToken,
        legacyToken
      )
    ) {
      res.locals
        .printDevice = null;

      return next();
    }


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
  } catch (error) {
    console.error(
      "Print-Agent-Authentifizierung fehlgeschlagen:",
      error
    );

    return res
      .status(500)
      .json({
        ok: false,
        error:
          "Print-Agent-Authentifizierung fehlgeschlagen.",
      });
  }
}

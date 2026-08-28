import crypto from "node:crypto";
import express from "express";

import { db } from "../database/db.js";

export const printerPairingRouter =
  express.Router();

printerPairingRouter.use(
  express.json()
);

/*
 * ALO PRINT CONNECTOR PAIRING
 *
 * Ablauf:
 *
 * 1. Shopify/Admin erzeugt einen Pairing-Code.
 * 2. Windows Connector zeigt/benutzt diesen Code.
 * 3. Connector tauscht den Code gegen einen eigenen Token.
 * 4. Pairing-Code wird sofort unbrauchbar.
 *
 * WICHTIG:
 * Pairing-Codes laufen nach 10 Minuten ab.
 */

const PAIRING_CODE_LIFETIME_MINUTES = 10;


/* ==========================================================
   HILFSFUNKTIONEN
========================================================== */

function generatePairingCode() {
  const number =
    crypto.randomInt(
      100000,
      1000000
    );

  return String(number);
}


function generateDeviceToken() {
  return crypto
    .randomBytes(32)
    .toString("hex");
}


function hashToken(token: string) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}


/* ==========================================================
   DATENBANK INITIALISIEREN
========================================================== */

export async function initPrinterPairingTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS
      printer_pairing_codes
    (
      id BIGSERIAL PRIMARY KEY,

      code TEXT NOT NULL UNIQUE,

      status TEXT NOT NULL
        DEFAULT 'PENDING',

      expires_at TIMESTAMPTZ
        NOT NULL,

      used_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);


  await db.query(`
    CREATE TABLE IF NOT EXISTS
      printer_devices
    (
      id BIGSERIAL PRIMARY KEY,

      device_id TEXT NOT NULL UNIQUE,

      device_name TEXT,

      platform TEXT,

      agent_version TEXT,

      token_hash TEXT
        NOT NULL UNIQUE,

      status TEXT NOT NULL
        DEFAULT 'ONLINE',

      last_seen_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);


  await db.query(`
    CREATE INDEX IF NOT EXISTS
      printer_pairing_codes_status_idx

    ON printer_pairing_codes
      (status, expires_at);
  `);


  await db.query(`
    CREATE INDEX IF NOT EXISTS
      printer_devices_last_seen_idx

    ON printer_devices
      (last_seen_at);
  `);
}


/* ==========================================================
   ADMIN:
   NEUEN PAIRING-CODE ERSTELLEN

   Später wird dieser Endpoint ausschließlich über
   die authentifizierte Shopify-App aufgerufen.
========================================================== */

printerPairingRouter.post(
  "/api/printer-pairing/create",

  async (_req, res) => {
    try {
      /*
       * Alte offene Codes ungültig machen.
       * Dadurch gibt es normalerweise nur
       * einen aktuellen Pairing-Code.
       */

      await db.query(`
        UPDATE printer_pairing_codes

        SET status = 'EXPIRED'

        WHERE
          status = 'PENDING'

          AND expires_at <= NOW();
      `);


      let code = "";
      let created = false;

      /*
       * Sehr unwahrscheinliche Code-Kollisionen
       * werden sauber abgefangen.
       */

      for (
        let attempt = 0;
        attempt < 5;
        attempt += 1
      ) {
        code =
          generatePairingCode();

        try {
          await db.query(
            `
              INSERT INTO
                printer_pairing_codes
              (
                code,
                expires_at
              )

              VALUES
              (
                $1,
                NOW()
                + ($2 * INTERVAL '1 minute')
              );
            `,
            [
              code,
              PAIRING_CODE_LIFETIME_MINUTES,
            ]
          );

          created = true;

          break;
        } catch (error: any) {
          if (
            error?.code ===
            "23505"
          ) {
            continue;
          }

          throw error;
        }
      }


      if (!created) {
        throw new Error(
          "Pairing-Code konnte nicht erstellt werden."
        );
      }


      return res.json({
        ok: true,

        code,

        expiresInMinutes:
          PAIRING_CODE_LIFETIME_MINUTES,
      });
    } catch (error: any) {
      console.error(
        "Printer Pairing Create Error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ??
            "Pairing-Code konnte nicht erstellt werden.",
        });
    }
  }
);


/* ==========================================================
   CONNECTOR:
   PAIRING-CODE EINLÖSEN
========================================================== */

printerPairingRouter.post(
  "/api/printer-pairing/claim",

  async (req, res) => {
    const client =
      await db.connect();

    try {
      const code =
        String(
          req.body?.code ?? ""
        )
          .replace(/\s/g, "")
          .trim();


      const deviceName =
        String(
          req.body?.deviceName ??
          ""
        ).trim();


      const platform =
        String(
          req.body?.platform ??
          "windows"
        ).trim();


      const agentVersion =
        String(
          req.body?.agentVersion ??
          ""
        ).trim();


      if (
        !/^\d{6}$/.test(code)
      ) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              "Ungültiger Pairing-Code.",
          });
      }


      if (!deviceName) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              "deviceName fehlt.",
          });
      }


      await client.query(
        "BEGIN"
      );


      const pairingResult =
        await client.query(
          `
            SELECT
              id,
              code,
              status,
              expires_at

            FROM printer_pairing_codes

            WHERE code = $1

            FOR UPDATE;
          `,
          [code]
        );


      const pairing =
        pairingResult.rows[0];


      if (!pairing) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(404)
          .json({
            ok: false,

            error:
              "Pairing-Code nicht gefunden.",
          });
      }


      if (
        pairing.status !==
        "PENDING"
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(409)
          .json({
            ok: false,

            error:
              "Pairing-Code wurde bereits verwendet.",
          });
      }


      if (
        new Date(
          pairing.expires_at
        ).getTime() <=
        Date.now()
      ) {
        await client.query(
          `
            UPDATE printer_pairing_codes

            SET status = 'EXPIRED'

            WHERE id = $1;
          `,
          [pairing.id]
        );

        await client.query(
          "COMMIT"
        );

        return res
          .status(410)
          .json({
            ok: false,

            error:
              "Pairing-Code ist abgelaufen.",
          });
      }


      const deviceId =
        crypto.randomUUID();


      const deviceToken =
        generateDeviceToken();


      const tokenHash =
        hashToken(
          deviceToken
        );


      const deviceResult =
        await client.query(
          `
            INSERT INTO
              printer_devices
            (
              device_id,
              device_name,
              platform,
              agent_version,
              token_hash,
              status,
              last_seen_at
            )

            VALUES
            (
              $1,
              $2,
              $3,
              $4,
              $5,
              'ONLINE',
              NOW()
            )

            RETURNING
              id,
              device_id,
              device_name,
              platform,
              agent_version,
              status,
              last_seen_at,
              created_at;
          `,
          [
            deviceId,
            deviceName,
            platform,
            agentVersion || null,
            tokenHash,
          ]
        );


      await client.query(
        `
          UPDATE printer_pairing_codes

          SET
            status = 'USED',
            used_at = NOW()

          WHERE id = $1;
        `,
        [pairing.id]
      );


      await client.query(
        "COMMIT"
      );


      return res.json({
        ok: true,

        device:
          deviceResult.rows[0],

        deviceToken,
      });
    } catch (error: any) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {
        // Verbindung kann bereits beendet sein.
      }


      console.error(
        "Printer Pairing Claim Error:",
        error
      );


      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ??
            "Connector konnte nicht gekoppelt werden.",
        });
    } finally {
      client.release();
    }
  }
);


/* ==========================================================
   ADMIN:
   VERBUNDENE WINDOWS-GERÄTE

   Auch dieser Endpoint wird vor Produktion noch
   über Shopify-Admin-Authentifizierung geschützt.
========================================================== */

printerPairingRouter.get(
  "/api/printer-devices",

  async (_req, res) => {
    try {
      const result =
        await db.query(`
          SELECT
            id,
            device_id,
            device_name,
            platform,
            agent_version,
            status,
            last_seen_at,
            created_at,
            updated_at

          FROM printer_devices

          ORDER BY
            created_at DESC;
        `);


      return res.json({
        ok: true,

        count:
          result.rows.length,

        devices:
          result.rows,
      });
    } catch (error: any) {
      console.error(
        "Printer Devices Error:",
        error
      );


      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ??
            "Geräte konnten nicht geladen werden.",
        });
    }
  }
);

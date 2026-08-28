import { db } from "./db.js";

export type PrinterStatus =
  | "ONLINE"
  | "OFFLINE"
  | "ERROR";

export type PrinterRecord = {
  id: string;

  name: string;

  display_name:
    | string
    | null;

  location:
    | string
    | null;

  platform:
    | string
    | null;

  status: PrinterStatus;

  is_default: boolean;

  agent_version:
    | string
    | null;

  device_name:
    | string
    | null;

  driver_name:
    | string
    | null;

  port_name:
    | string
    | null;

  paper_size:
    | string
    | null;

  capabilities: Record<
    string,
    unknown
  >;

  last_error:
    | string
    | null;

  last_seen_at:
    | Date
    | null;

  created_at: Date;

  updated_at: Date;
};


// ==========================================================
// ALLE DRUCKER
// ==========================================================

export async function getPrinters():
Promise<PrinterRecord[]> {
  const result =
    await db.query<PrinterRecord>(
      `
        SELECT *
        FROM printers
        ORDER BY
          is_default DESC,
          location ASC NULLS LAST,
          display_name ASC NULLS LAST,
          name ASC
      `
    );

  return result.rows;
}


// ==========================================================
// EINEN DRUCKER
// ==========================================================

export async function getPrinterById(
  id: string
):
Promise<PrinterRecord | null> {
  const result =
    await db.query<PrinterRecord>(
      `
        SELECT *
        FROM printers
        WHERE id = $1
        LIMIT 1
      `,
      [
        id,
      ]
    );

  return result.rows[0] ?? null;
}


// ==========================================================
// DRUCKER NACH SYSTEM-NAME
// ==========================================================

export async function getPrinterByName(
  name: string
):
Promise<PrinterRecord | null> {
  const result =
    await db.query<PrinterRecord>(
      `
        SELECT *
        FROM printers
        WHERE name = $1
        LIMIT 1
      `,
      [
        name,
      ]
    );

  return result.rows[0] ?? null;
}


// ==========================================================
// STANDARD-DRUCKER
// ==========================================================

export async function getDefaultPrinter():
Promise<PrinterRecord | null> {
  const result =
    await db.query<PrinterRecord>(
      `
        SELECT *
        FROM printers
        WHERE is_default = TRUE
        ORDER BY updated_at DESC
        LIMIT 1
      `
    );

  return result.rows[0] ?? null;
}


// ==========================================================
// DRUCKER ANLEGEN / AKTUALISIEREN
// ==========================================================

export async function upsertPrinter(
  input: {
    name: string;

    displayName?: string;

    location?: string;

    platform?: string;

    status?: PrinterStatus;

    agentVersion?: string;

    deviceName?: string;

    driverName?: string;

    portName?: string;

    paperSize?: string;

    capabilities?: Record<
      string,
      unknown
    >;
  }
):
Promise<PrinterRecord> {
  const name =
    input.name.trim();

  if (!name) {
    throw new Error(
      "Printer name fehlt."
    );
  }

  const result =
    await db.query<PrinterRecord>(
      `
        INSERT INTO printers (
          name,
          display_name,
          location,
          platform,
          status,
          agent_version,
          device_name,
          driver_name,
          port_name,
          paper_size,
          capabilities,
          last_error,
          last_seen_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11::jsonb,
          NULL,
          NOW(),
          NOW()
        )

        ON CONFLICT (name)

        DO UPDATE SET
          display_name =
            COALESCE(
              EXCLUDED.display_name,
              printers.display_name
            ),

          location =
            COALESCE(
              EXCLUDED.location,
              printers.location
            ),

          platform =
            COALESCE(
              EXCLUDED.platform,
              printers.platform
            ),

          status =
            EXCLUDED.status,

          agent_version =
            COALESCE(
              EXCLUDED.agent_version,
              printers.agent_version
            ),

          device_name =
            COALESCE(
              EXCLUDED.device_name,
              printers.device_name
            ),

          driver_name =
            COALESCE(
              EXCLUDED.driver_name,
              printers.driver_name
            ),

          port_name =
            COALESCE(
              EXCLUDED.port_name,
              printers.port_name
            ),

          paper_size =
            COALESCE(
              EXCLUDED.paper_size,
              printers.paper_size
            ),

          capabilities =
            CASE
              WHEN EXCLUDED.capabilities =
                '{}'::jsonb
              THEN printers.capabilities
              ELSE EXCLUDED.capabilities
            END,

          last_error = NULL,

          last_seen_at = NOW(),

          updated_at = NOW()

        RETURNING *
      `,
      [
        name,

        input.displayName?.trim()
          || null,

        input.location?.trim()
          || null,

        input.platform?.trim()
          || null,

        input.status
          ?? "ONLINE",

        input.agentVersion?.trim()
          || null,

        input.deviceName?.trim()
          || null,

        input.driverName?.trim()
          || null,

        input.portName?.trim()
          || null,

        input.paperSize?.trim()
          || null,

        JSON.stringify(
          input.capabilities
          ?? {}
        ),
      ]
    );

  if (!result.rows[0]) {
    throw new Error(
      "Drucker konnte nicht gespeichert werden."
    );
  }

  return result.rows[0];
}


// ==========================================================
// HEARTBEAT
// ==========================================================

export async function heartbeatPrinter(
  name: string,
  input?: {
    status?: PrinterStatus;

    agentVersion?: string;

    deviceName?: string;

    driverName?: string;

    portName?: string;

    paperSize?: string;

    capabilities?: Record<
      string,
      unknown
    >;
  }
):
Promise<PrinterRecord> {
  return upsertPrinter({
    name,

    status:
      input?.status
      ?? "ONLINE",

    agentVersion:
      input?.agentVersion,

    deviceName:
      input?.deviceName,

    driverName:
      input?.driverName,

    portName:
      input?.portName,

    paperSize:
      input?.paperSize,

    capabilities:
      input?.capabilities,
  });
}


// ==========================================================
// STATUS ÄNDERN
// ==========================================================

export async function setPrinterStatus(
  id: string,
  status: PrinterStatus,
  errorMessage?: string
):
Promise<PrinterRecord> {
  const result =
    await db.query<PrinterRecord>(
      `
        UPDATE printers

        SET
          status = $2,

          last_error = $3,

          updated_at = NOW(),

          last_seen_at =
            CASE
              WHEN $2 = 'ONLINE'
              THEN NOW()
              ELSE last_seen_at
            END

        WHERE id = $1

        RETURNING *
      `,
      [
        id,
        status,
        errorMessage ?? null,
      ]
    );

  if (!result.rows[0]) {
    throw new Error(
      "Drucker nicht gefunden."
    );
  }

  return result.rows[0];
}


// ==========================================================
// STANDARD-DRUCKER SETZEN
// ==========================================================

export async function setDefaultPrinter(
  id: string
):
Promise<PrinterRecord> {
  const client =
    await db.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const existing =
      await client.query<PrinterRecord>(
        `
          SELECT *
          FROM printers
          WHERE id = $1
          LIMIT 1
          FOR UPDATE
        `,
        [
          id,
        ]
      );

    if (!existing.rows[0]) {
      throw new Error(
        "Drucker nicht gefunden."
      );
    }

    await client.query(`
      UPDATE printers
      SET
        is_default = FALSE,
        updated_at = NOW()
      WHERE is_default = TRUE
    `);

    const result =
      await client.query<PrinterRecord>(
        `
          UPDATE printers

          SET
            is_default = TRUE,
            updated_at = NOW()

          WHERE id = $1

          RETURNING *
        `,
        [
          id,
        ]
      );

    await client.query(
      "COMMIT"
    );

    return result.rows[0];
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }
}


// ==========================================================
// DRUCKER BEARBEITEN
// ==========================================================

export async function updatePrinter(
  id: string,
  input: {
    displayName?: string | null;

    location?: string | null;

    paperSize?: string | null;
  }
):
Promise<PrinterRecord> {
  const result =
    await db.query<PrinterRecord>(
      `
        UPDATE printers

        SET
          display_name = COALESCE(
            $2,
            display_name
          ),

          location = COALESCE(
            $3,
            location
          ),

          paper_size = COALESCE(
            $4,
            paper_size
          ),

          updated_at = NOW()

        WHERE id = $1

        RETURNING *
      `,
      [
        id,

        input.displayName
          ?? null,

        input.location
          ?? null,

        input.paperSize
          ?? null,
      ]
    );

  if (!result.rows[0]) {
    throw new Error(
      "Drucker nicht gefunden."
    );
  }

  return result.rows[0];
}


// ==========================================================
// DRUCKER LÖSCHEN
// ==========================================================

export async function deletePrinter(
  id: string
):
Promise<boolean> {
  const result =
    await db.query(
      `
        DELETE FROM printers
        WHERE id = $1
        RETURNING id
      `,
      [
        id,
      ]
    );

  return Boolean(
    result.rows[0]
  );
}


// ==========================================================
// VERALTETE DRUCKER OFFLINE SETZEN
// ==========================================================

export async function markStalePrintersOffline(
  staleAfterSeconds = 60
) {
  const safeSeconds =
    Math.max(
      10,
      Math.floor(
        staleAfterSeconds
      )
    );

  const result =
    await db.query<PrinterRecord>(
      `
        UPDATE printers

        SET
          status = 'OFFLINE',
          updated_at = NOW()

        WHERE
          status = 'ONLINE'

          AND (
            last_seen_at IS NULL

            OR last_seen_at <
              NOW()
              - ($1 * INTERVAL '1 second')
          )

        RETURNING *
      `,
      [
        safeSeconds,
      ]
    );

  return result.rows;
}

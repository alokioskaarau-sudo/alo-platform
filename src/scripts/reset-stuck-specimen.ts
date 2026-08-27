import "dotenv/config";

import { db } from "../database/db.js";

async function main() {
  try {
    const before = await db.query(
      `
        SELECT
          id,
          shopify_order_name,
          label_mode,
          status,
          swisspost_ident_code,
          created_at,
          updated_at
        FROM shipping_labels
        WHERE shopify_order_name = $1
          AND label_mode = 'SPECIMEN'
        LIMIT 1
      `,
      ["#50001006ALO"]
    );

    const existing = before.rows[0];

    if (!existing) {
      console.log(
        "Kein SPECIMEN-Datensatz für #50001006ALO gefunden."
      );

      return;
    }

    console.log("Gefundener Datensatz:");
    console.log(existing);

    if (existing.status === "COMPLETED") {
      console.log(
        "ABBRUCH: Das Label ist bereits COMPLETED und wird nicht gelöscht."
      );

      return;
    }

    if (
      existing.status !== "RESERVED" &&
      existing.status !== "FAILED"
    ) {
      console.log(
        `ABBRUCH: Unbekannter Status ${existing.status}.`
      );

      return;
    }

    const deleted = await db.query(
      `
        DELETE FROM shipping_labels
        WHERE shopify_order_name = $1
          AND label_mode = 'SPECIMEN'
          AND status IN ('RESERVED', 'FAILED')
        RETURNING
          id,
          shopify_order_name,
          label_mode,
          status
      `,
      ["#50001006ALO"]
    );

    if (deleted.rowCount === 1) {
      console.log(
        "Festhängender SPECIMEN-Datensatz erfolgreich entfernt."
      );
      console.log(deleted.rows[0]);
    } else {
      console.log(
        "Es wurde kein Datensatz gelöscht."
      );
    }
  } catch (error) {
    console.error(
      "Reset fehlgeschlagen:",
      error
    );

    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main();

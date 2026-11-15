/**
 * ALO NOW V1815
 * Server-only, read-only PostgreSQL adapter.
 * Never grants commission or payout authority.
 */
import { db } from "../../database/db.js";

import {
  readEarningsLedgerV1815
} from "./aloNowEarningsLedger.v1815.js";

import type {
  LedgerScopeV1815,
  LedgerResultV1815
} from "./aloNowEarningsLedger.v1815.js";

export async function readLiveEarningsLedgerV1815(
  scope: LedgerScopeV1815
): Promise<LedgerResultV1815> {
  return readEarningsLedgerV1815(
    scope,
    async (sql, params) => {
      if (!/^\s*SELECT\b/i.test(sql)) {
        throw new Error("READ_ONLY_REQUIRED");
      }

      const response = await db.query(sql, [...params]);

      return { rows: response.rows };
    }
  );
}

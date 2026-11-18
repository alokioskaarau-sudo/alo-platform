
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  transitionAloNowPayment,
} from "./aloNowPaymentLifecycle.js";

/**
 * MUST run in the caller's existing transaction.
 * Does not commit, rollback, authenticate, or create a reservation.
 * The parent request must already be locked by the caller.
 */
export async function recordAloNowAcceptedPaymentInTransaction(
  client: PoolClient,
  requestId: string,
  driverId: string
): Promise<void> {
  const request = await client.query<{
    status: string;
    driver_user_id: string | null;
    reservation_valid: boolean;
  }>(
    `SELECT status, driver_user_id,
            COALESCE(
              reservation_expires_at > clock_timestamp(),
              FALSE
            ) AS reservation_valid
     FROM alo_now_order_requests
     WHERE id = $1
     FOR UPDATE`,
    [requestId]
  );

  const row = request.rows[0];
  if (
    !row ||
    row.status !== "DRIVER_ACCEPTED" ||
    row.driver_user_id !== driverId ||
    !row.reservation_valid
  ) {
    throw new Error("ATOMIC_ACCEPTANCE_RESERVATION_INVALID");
  }

  await client.query(
    `INSERT INTO alo_now_payment_states
       (id, request_id, phase, version)
     VALUES ($1, $2, 'AWAITING_DRIVER', 1)
     ON CONFLICT (request_id) DO NOTHING`,
    [randomUUID(), requestId]
  );

  const current = await client.query<{
    id: string;
    phase: string;
    payment_method: string | null;
    version: number;
  }>(
    `SELECT id, phase, payment_method, version
     FROM alo_now_payment_states
     WHERE request_id = $1
     FOR UPDATE`,
    [requestId]
  );

  const state = current.rows[0];
  if (!state) throw new Error("PAYMENT_STATE_MISSING");

  if (state.phase !== "AWAITING_DRIVER") {
    throw new Error("ATOMIC_ACCEPTANCE_PAYMENT_STATE_CONFLICT");
  }

  const transition = transitionAloNowPayment(
    { phase: "AWAITING_DRIVER", method: null },
    { type: "DRIVER_ACCEPTED" }
  );

  if (!transition.ok) {
    throw new Error("PAYMENT_TRANSITION_REJECTED");
  }

  const nextVersion = state.version + 1;

  const updated = await client.query(
    `UPDATE alo_now_payment_states
     SET phase = $2,
         payment_method = $3,
         version = $4,
         updated_at = NOW()
     WHERE id = $1 AND version = $5`,
    [
      state.id,
      transition.state.phase,
      transition.state.method,
      nextVersion,
      state.version,
    ]
  );

  if (updated.rowCount !== 1) {
    throw new Error("PAYMENT_VERSION_CONFLICT");
  }

  await client.query(
    `INSERT INTO alo_now_payment_events
       (id, payment_state_id, event_type,
        previous_phase, next_phase,
        actor_type, actor_id, resulting_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      randomUUID(),
      state.id,
      "DRIVER_ACCEPTED",
      "AWAITING_DRIVER",
      "DRIVER_ACCEPTED",
      "DRIVER",
      driverId,
      nextVersion,
    ]
  );
}

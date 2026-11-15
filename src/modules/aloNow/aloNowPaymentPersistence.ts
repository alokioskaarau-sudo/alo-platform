
import { randomUUID } from "node:crypto";
import { db } from "../../database/db.js";
import {
  transitionAloNowPayment,
  type PaymentEvent,
  type PaymentLifecycle
} from "./aloNowPaymentLifecycle.js";

export type PaymentActor =
  "DRIVER" | "ADMIN" | "CUSTOMER" | "SYSTEM" | "SHOPIFY";

type Input = {
  requestId: string;
  event: PaymentEvent;
  actorType: PaymentActor;
  actorId?: string | null;
  sourceReference?: string | null;
};

type Result =
  | { ok: true; state: PaymentLifecycle; version: number }
  | { ok: false; reason: string };

type Row = {
  id: string;
  phase: PaymentLifecycle["phase"];
  payment_method: PaymentLifecycle["method"];
  version: number;
};

function allowedActor(event: PaymentEvent["type"], actor: PaymentActor) {
  switch (event) {
    case "DRIVER_ACCEPTED":
      return actor === "DRIVER" || actor === "ADMIN";
    case "ONLINE_PAYMENT_REQUESTED":
      return actor === "SYSTEM" || actor === "ADMIN";
    case "ONLINE_PAYMENT_VERIFIED":
      return actor === "SHOPIFY";
    case "CASH_AGREEMENT_VERIFIED":
      return actor === "ADMIN";
    case "RESERVATION_EXPIRED":
      return actor === "SYSTEM";
    case "CANCELLED":
      return actor === "SYSTEM" || actor === "ADMIN";
  }
}

/**
 * Internal persistence function, NOT a public API.
 * Actor roles are assertions, not authentication.
 *
 * The caller must authenticate the actor and verify:
 * - request ownership and reservation validity
 * - driver assignment
 * - genuine Shopify payment evidence
 *
 * Those integrations are not implemented here.
 */
export async function applyAloNowPaymentEvent(
  input: Input
): Promise<Result> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.requestId)) {
    return { ok: false, reason: "INVALID_REQUEST_ID" };
  }

  if (!allowedActor(input.event.type, input.actorType)) {
    return { ok: false, reason: "ACTOR_NOT_ALLOWED" };
  }

  const client = await db.connect();
  let inTransaction = false;
  let destroy = false;

  try {
    await client.query("BEGIN");
    inTransaction = true;

    // Parent row is locked first. Parallel initializations
    // of the same request are therefore serialized.
    // ALO_V255_RESERVATION_GUARD
    const request = await client.query<{
      status: string;
      driver_user_id: string | null;
      reservation_valid: boolean;
    }>(
      `SELECT status, driver_user_id,
              COALESCE(
                reservation_expires_at > NOW(), FALSE
              ) AS reservation_valid
       FROM alo_now_order_requests
       WHERE id = $1 FOR UPDATE`,
      [input.requestId]
    );

    if (request.rowCount !== 1) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return { ok: false, reason: "REQUEST_NOT_FOUND" };
    }

    const reservation = request.rows[0];

    if (
      input.event.type === "DRIVER_ACCEPTED" &&
      (
        !input.actorId ||
        input.actorType !== "DRIVER" &&
          input.actorType !== "ADMIN"
      )
    ) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return { ok: false, reason: "DRIVER_ID_REQUIRED" };
    }

    if (
      input.event.type === "DRIVER_ACCEPTED" ||
      input.event.type === "ONLINE_PAYMENT_REQUESTED" ||
      input.event.type === "ONLINE_PAYMENT_VERIFIED" ||
      input.event.type === "CASH_AGREEMENT_VERIFIED"
    ) {
      if (
        reservation.status !== "DRIVER_ACCEPTED" ||
        !reservation.driver_user_id ||
        !reservation.reservation_valid
      ) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return {
          ok: false,
          reason: "VALID_DRIVER_RESERVATION_REQUIRED",
        };
      }

      if (
        input.event.type === "DRIVER_ACCEPTED" &&
        reservation.driver_user_id !== input.actorId
      ) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return {
          ok: false,
          reason: "DRIVER_RESERVATION_MISMATCH",
        };
      }
    }

    await client.query(
      `INSERT INTO alo_now_payment_states
         (id, request_id, phase, version)
       VALUES ($1, $2, 'AWAITING_DRIVER', 1)
       ON CONFLICT (request_id) DO NOTHING`,
      [randomUUID(), input.requestId]
    );

    const current = await client.query<Row>(
      `SELECT id, phase, payment_method, version
       FROM alo_now_payment_states
       WHERE request_id = $1 FOR UPDATE`,
      [input.requestId]
    );

    const row = current.rows[0];
    if (!row) throw Error("PAYMENT_STATE_MISSING");

    const next = transitionAloNowPayment(
      { phase: row.phase, method: row.payment_method },
      input.event
    );

    if (!next.ok) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return { ok: false, reason: next.reason };
    }

    const newVersion = row.version + 1;

    const updated = await client.query(
      `UPDATE alo_now_payment_states
       SET phase = $2, payment_method = $3,
           version = $4, updated_at = NOW()
       WHERE id = $1 AND version = $5`,
      [
        row.id, next.state.phase,
        next.state.method, newVersion, row.version
      ]
    );

    if (updated.rowCount !== 1) {
      throw Error("PAYMENT_CONCURRENT_UPDATE");
    }

    await client.query(
      `INSERT INTO alo_now_payment_events (
         id, payment_state_id, event_type,
         previous_phase, next_phase, actor_type,
         actor_id, source_reference, resulting_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(), row.id, input.event.type,
        row.phase, next.state.phase, input.actorType,
        input.actorId ?? null,
        input.sourceReference ?? null, newVersion
      ]
    );

    await client.query("COMMIT");
    inTransaction = false;

    return {
      ok: true,
      state: next.state,
      version: newVersion
    };
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch {
        destroy = true;
      }
    }
    throw error;
  } finally {
    client.release(destroy);
  }
}

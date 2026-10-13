import type { PoolClient } from "pg";
import { db } from "./db.js";

export class StaffScheduleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaffScheduleConflictError";
  }
}

export async function withStaffScheduleTransaction<T>(
  staffUserId: number,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (
    !Number.isSafeInteger(staffUserId) ||
    staffUserId <= 0
  ) {
    throw new Error("Ungültige Mitarbeiter-ID.");
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Gemeinsame Sperre für alle V51-Schreiboperationen
    // desselben Mitarbeiters.
    const employee = await client.query(
      `
        SELECT id
        FROM staff_users
        WHERE id = $1
        FOR UPDATE
      `,
      [staffUserId]
    );

    if (!employee.rows.length) {
      throw new Error("Mitarbeiter nicht gefunden.");
    }

    const result = await operation(client);

    await client.query("COMMIT");

    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function assertNoApprovedAbsence(
  client: PoolClient,
  staffUserId: number,
  startsAt: Date,
  endsAt: Date
): Promise<void> {
  const result = await client.query(
    `
      SELECT id
      FROM staff_schedule_requests
      WHERE staff_user_id = $1
        AND status = 'APPROVED'
        AND starts_at < $3
        AND ends_at > $2
      LIMIT 1
    `,
    [staffUserId, startsAt, endsAt]
  );

  if (result.rows.length) {
    throw new StaffScheduleConflictError(
      "Schicht überschneidet sich mit genehmigter Abwesenheit."
    );
  }
}

export async function assertNoShiftConflict(
  client: PoolClient,
  staffUserId: number,
  startsAt: Date,
  endsAt: Date,
  excludeShiftId?: number
): Promise<void> {
  const result = await client.query(
    `
      SELECT id
      FROM staff_schedule_shifts
      WHERE staff_user_id = $1
        AND status <> 'CANCELLED'
        AND starts_at < $3
        AND ends_at > $2
        AND ($4::bigint IS NULL OR id <> $4)
      LIMIT 1
    `,
    [
      staffUserId,
      startsAt,
      endsAt,
      excludeShiftId ?? null,
    ]
  );

  if (result.rows.length) {
    throw new StaffScheduleConflictError(
      "Mitarbeiter hat bereits eine überschneidende Schicht."
    );
  }
}


/**
 * Sperrt mehrere Mitarbeiter in aufsteigender ID-Reihenfolge.
 * Für Schichtübertragungen zwischen Mitarbeitern.
 */
export async function withStaffScheduleEmployeesTransaction<T>(
  staffUserIds: number[],
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const ids = [...new Set(staffUserIds)].sort((a, b) => a - b);

  if (
    ids.length === 0 ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new Error("Ungültige Mitarbeiter-IDs.");
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Einzeln und deterministisch sperren:
    // schützt vor unterschiedlicher Lock-Reihenfolge.
    for (const id of ids) {
      const employee = await client.query(
        `
          SELECT id
          FROM staff_users
          WHERE id = $1
          FOR UPDATE
        `,
        [id]
      );

      if (!employee.rows.length) {
        throw new Error("Mitarbeiter nicht gefunden.");
      }
    }

    const result = await operation(client);

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

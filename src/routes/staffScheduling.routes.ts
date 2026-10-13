import {
  withStaffScheduleTransaction,
  withStaffScheduleEmployeesTransaction,
  assertNoApprovedAbsence,
  assertNoShiftConflict,
  StaffScheduleConflictError,
} from "../database/staffSchedulingTransaction.js";
import { Router } from "express";
import { db } from "../database/db.js";
import { effectiveStaffCapabilities } from "../middleware/staffRbac.js";
import {
  requireStaffAuth,
  getStaffUser,
} from "../middleware/staffAuth.js";

const router = Router();

router.use(requireStaffAuth);

// ALO_V51_HOURS_SETTINGS_API
// Einstellungen sind nur nach Anmeldung lesbar.
// Änderungen erfordern schedule.manage.

router.get("/settings", async (_req, res) => {
  try {
    const actor = getStaffUser(res);

    if (!actor) {
      return res.status(401).json({
        ok: false,
        error: "Nicht angemeldet.",
      });
    }

    const result = await db.query(
      `SELECT enabled
       FROM staff_schedule_settings
       WHERE key = $1`,
      ["show_employee_hours_statistics"]
    );

    return res.json({
      ok: true,
      showEmployeeHoursStatistics:
        result.rows[0]?.enabled === true,
    });
  } catch (error) {
    console.error("V51 GET SCHEDULE SETTINGS", error);

    return res.status(500).json({
      ok: false,
      error: "Dienstplan-Einstellungen konnten nicht geladen werden.",
    });
  }
});

router.patch("/settings", async (req, res) => {
  try {
    const actor = getStaffUser(res);

    if (!actor) {
      return res.status(401).json({
        ok: false,
        error: "Nicht angemeldet.",
      });
    }

    if (
      !effectiveStaffCapabilities(actor)
        .has("schedule.manage")
    ) {
      return res.status(403).json({
        ok: false,
        error: "Keine Berechtigung für Dienstplan-Einstellungen.",
      });
    }

    const enabled = req.body?.showEmployeeHoursStatistics;

    if (typeof enabled !== "boolean") {
      return res.status(400).json({
        ok: false,
        error: "showEmployeeHoursStatistics muss true oder false sein.",
      });
    }

    const result = await db.query(
      `INSERT INTO staff_schedule_settings
         (key, enabled, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key)
       DO UPDATE SET
         enabled = EXCLUDED.enabled,
         updated_at = NOW()
       RETURNING enabled`,
      ["show_employee_hours_statistics", enabled]
    );

    return res.json({
      ok: true,
      showEmployeeHoursStatistics:
        result.rows[0]?.enabled === true,
    });
  } catch (error) {
    console.error("V51 UPDATE SCHEDULE SETTINGS", error);

    return res.status(500).json({
      ok: false,
      error: "Dienstplan-Einstellung konnte nicht gespeichert werden.",
    });
  }
});



/**
 * ALO V51 – Mitarbeiter für die Schichtplanung
 *
 * Gibt nur Informationen zurück, die für den
 * Dienstplan erforderlich sind.
 *
 * Keine PINs, Passwörter oder privaten Profildaten.
 */
router.get("/employees", async (_req, res) => {
  try {
    const actor = getStaffUser(res);

    if (!actor) {
      return res.status(401).json({
        ok: false,
        error: "Nicht angemeldet.",
      });
    }

    if (!canManageSchedule(actor)) {
      return res.status(403).json({
        ok: false,
        error: "Keine Planungsberechtigung.",
      });
    }

    const result = await db.query(`
      SELECT
        id,
        display_name AS "displayName",
        role,
        default_workspace AS "defaultWorkspace"
      FROM staff_users
      WHERE active = TRUE
        AND approved_at IS NOT NULL
      ORDER BY
        display_name ASC
    `);

    return res.json({
      ok: true,
      employees: result.rows,
    });
  } catch (error) {
    console.error(
      "ALO V51 EMPLOYEES ERROR",
      error
    );

    return res.status(500).json({
      ok: false,
      error: "Mitarbeiter konnten nicht geladen werden.",
    });
  }
});


/**
 * ALO V51 – Schichtplanung
 *
 * ADMIN / MANAGER dürfen vorläufig planen.
 * Individuelle Planungsrechte folgen vor Freischaltung.
 */
function canManageSchedule(actor: any): boolean {
  if (!actor) return false;
  return effectiveStaffCapabilities(actor)
    .has("schedule.manage");
}


/**
 * ALO V51 – Veröffentlichter Teamplan.
 *
 * Für angemeldete Mitarbeiter lesbar.
 * Keine Entwürfe, keine internen Notizen,
 * keine Änderungsberechtigungen.
 */
router.get("/team-shifts", async (req, res) => {
  try {
    const actor = getStaffUser(res);

    if (!actor) {
      return res.status(401).json({
        ok: false,
        error: "Nicht angemeldet.",
      });
    }

    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");

    const fromDate = new Date(from);
    const toDate = new Date(to);

    if (
      !Number.isFinite(fromDate.getTime()) ||
      !Number.isFinite(toDate.getTime()) ||
      fromDate >= toDate
    ) {
      return res.status(400).json({
        ok: false,
        error: "Ungültiger Zeitraum.",
      });
    }

    const result = await db.query(
      `
      SELECT
        s.id,
        s.staff_user_id AS "staffUserId",
        u.display_name AS "employeeName",
        s.workspace,
        s.shift_preset AS "shiftPreset",
        s.starts_at AS "startsAt",
        s.ends_at AS "endsAt",
        s.status
      FROM staff_schedule_shifts s
      JOIN staff_users u
        ON u.id = s.staff_user_id
      WHERE s.status = 'PUBLISHED'
        AND s.starts_at < $2
        AND s.ends_at > $1
      ORDER BY s.starts_at, u.display_name
      `,
      [fromDate, toDate]
    );

    return res.json({
      ok: true,
      shifts: result.rows,
    });
  } catch (error) {
    console.error("V51 TEAM SHIFTS", error);

    return res.status(500).json({
      ok: false,
      error: "Teamplan konnte nicht geladen werden.",
    });
  }
});

router.get("/shifts", async (req, res) => {
  try {
    const actor = getStaffUser(res);
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");

    const fromDate = new Date(from);
    const toDate = new Date(to);

    if (
      !Number.isFinite(fromDate.getTime()) ||
      !Number.isFinite(toDate.getTime()) ||
      fromDate >= toDate
    ) {
      return res.status(400).json({
        ok: false,
        error: "Ungültiger Zeitraum.",
      });
    }

    const manager = canManageSchedule(actor);

    const result = await db.query(
      `
      SELECT
        s.id,
        s.staff_user_id AS "staffUserId",
        u.display_name AS "employeeName",
        s.workspace,
        s.shift_preset AS "shiftPreset",
        s.starts_at AS "startsAt",
        s.ends_at AS "endsAt",
        s.status,
        s.notes
      FROM staff_schedule_shifts s
      JOIN staff_users u ON u.id = s.staff_user_id
      WHERE s.starts_at < $2
        AND s.ends_at > $1
        AND (
          $3::boolean = TRUE
          OR (
            s.staff_user_id = $4
            AND s.status = 'PUBLISHED'
          )
        )
      ORDER BY s.starts_at, u.display_name
      `,
      [fromDate, toDate, manager, actor.id]
    );

    return res.json({
      ok: true,
      shifts: result.rows,
    });
  } catch (error) {
    console.error("V51 LIST SHIFTS", error);
    return res.status(500).json({
      ok: false,
      error: "Schichten konnten nicht geladen werden.",
    });
  }
});

router.post("/shifts", async (req, res) => {
  try {
    const actor = getStaffUser(res);

    if (!canManageSchedule(actor)) {
      return res.status(403).json({
        ok: false,
        error: "Keine Berechtigung zur Schichtplanung.",
      });
    }

    const staffUserId = Number(req.body?.staffUserId);
    const workspace = String(req.body?.workspace ?? "");
    const startsAt = new Date(req.body?.startsAt);
    const endsAt = new Date(req.body?.endsAt);

    // ALO_V51_SHIFT_PRESET_API
    const rawPreset = req.body?.shiftPreset;
    const shiftPreset =
      rawPreset === undefined
        ? undefined
        : String(rawPreset);
    const validShiftPreset =
      shiftPreset === undefined ||
      ["EARLY", "LATE", "FULL", "CUSTOM"].includes(
        shiftPreset
      );
    const notes = String(req.body?.notes ?? "").trim();

    if (
      !Number.isSafeInteger(staffUserId) ||
      staffUserId <= 0 ||
      !["AARAU", "OLTEN"].includes(workspace) ||
      !Number.isFinite(startsAt.getTime()) ||
      !Number.isFinite(endsAt.getTime()) ||
      startsAt >= endsAt ||
      !validShiftPreset
    ) {
      return res.status(400).json({
        ok: false,
        error: "Ungültige Schichtdaten.",
      });
    }

    const shift = await withStaffScheduleTransaction(
      staffUserId,
      async (client) => {
        const employee = await client.query(
          `
            SELECT id FROM staff_users
            WHERE id = $1
              AND active = TRUE
              AND approved_at IS NOT NULL
            LIMIT 1
          `,
          [staffUserId]
        );

        if (!employee.rows.length) {
          return null;
        }

        await assertNoShiftConflict(
          client,
          staffUserId,
          startsAt,
          endsAt
        );

        await assertNoApprovedAbsence(
          client,
          staffUserId,
          startsAt,
          endsAt
        );

        const result = await client.query(
          `
            INSERT INTO staff_schedule_shifts (
              staff_user_id,
              workspace,
              starts_at,
              ends_at,
              status,
              notes,
              created_by_user_id,
              shift_preset
            )
            VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7)
            RETURNING *
          `,
          [
            staffUserId,
            workspace,
            startsAt,
            endsAt,
            notes || null,
            actor.id,
              shiftPreset ?? "CUSTOM",
          ]
        );

        return result.rows[0];
      }
    );

    if (!shift) {
      return res.status(404).json({
        ok: false,
        error: "Mitarbeiter nicht gefunden.",
      });
    }

    return res.status(201).json({
      ok: true,
      shift,
    });
  } catch (error: any) {
    if (error instanceof StaffScheduleConflictError) {
      return res.status(409).json({
        ok: false,
        error: error.message,
      });
    }

    if (error?.code === "23P01") {
      return res.status(409).json({
        ok: false,
        error: "Überschneidung mit einer bestehenden Schicht.",
      });
    }

    console.error("V51 CREATE SHIFT", error);
    return res.status(500).json({
      ok: false,
      error: "Schicht konnte nicht erstellt werden.",
    });
  }
});


router.patch("/shifts/:id", async (req, res) => {
  try {
    const actor = getStaffUser(res);

    if (!canManageSchedule(actor)) {
      return res.status(403).json({
        ok: false,
        error: "Keine Planungsberechtigung.",
      });
    }

    const id = Number(req.params.id);
    const staffUserId = Number(req.body?.staffUserId);
    const workspace = String(req.body?.workspace ?? "");
    const startsAt = new Date(req.body?.startsAt);
    const endsAt = new Date(req.body?.endsAt);

    // ALO_V51_SHIFT_PRESET_API
    const rawPreset = req.body?.shiftPreset;
    const shiftPreset =
      rawPreset === undefined
        ? undefined
        : String(rawPreset);
    const validShiftPreset =
      shiftPreset === undefined ||
      ["EARLY", "LATE", "FULL", "CUSTOM"].includes(
        shiftPreset
      );
    const notes = String(req.body?.notes ?? "").trim();

    if (
      !Number.isSafeInteger(id) || id <= 0 ||
      !Number.isSafeInteger(staffUserId) || staffUserId <= 0 ||
      !["AARAU", "OLTEN"].includes(workspace) ||
      !Number.isFinite(startsAt.getTime()) ||
      !Number.isFinite(endsAt.getTime()) ||
      startsAt >= endsAt ||
      !validShiftPreset ||
      notes.length > 2000
    ) {
      return res.status(400).json({
        ok: false,
        error: "Ungültige Schichtdaten.",
      });
    }

    // Erst den bisherigen Mitarbeiter ermitteln.
    const existing = await db.query(
      `
        SELECT staff_user_id
        FROM staff_schedule_shifts
        WHERE id = $1
          AND status <> 'CANCELLED'
      `,
      [id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Schicht nicht gefunden.",
      });
    }

    const previousStaffUserId = Number(
      existing.rows[0].staff_user_id
    );

    const shift = await withStaffScheduleEmployeesTransaction(
      [previousStaffUserId, staffUserId],
      async (client) => {
        // Nach dem Sperren erneut prüfen.
        const current = await client.query(
          `
            SELECT staff_user_id
            FROM staff_schedule_shifts
            WHERE id = $1
              AND status <> 'CANCELLED'
          `,
          [id]
        );

        if (!current.rows.length) {
          return null;
        }

        if (
          Number(current.rows[0].staff_user_id) !==
          previousStaffUserId
        ) {
          throw new StaffScheduleConflictError(
            "Schicht wurde zwischenzeitlich geändert. Bitte neu laden."
          );
        }

        const employee = await client.query(
          `
            SELECT id
            FROM staff_users
            WHERE id = $1
              AND active = TRUE
              AND approved_at IS NOT NULL
          `,
          [staffUserId]
        );

        if (!employee.rows.length) {
          return null;
        }

        await assertNoShiftConflict(
          client,
          staffUserId,
          startsAt,
          endsAt,
          id
        );

        await assertNoApprovedAbsence(
          client,
          staffUserId,
          startsAt,
          endsAt
        );

        const result = await client.query(
          `
            UPDATE staff_schedule_shifts
            SET staff_user_id = $2,
                workspace = $3,
                starts_at = $4,
                ends_at = $5,
                notes = $6,
                shift_preset = COALESCE($9::text, shift_preset),
                updated_by_user_id = $7,
                updated_at = NOW()
            WHERE id = $1
              AND status <> 'CANCELLED'
              AND staff_user_id = $8
            RETURNING *
          `,
          [
            id,
            staffUserId,
            workspace,
            startsAt,
            endsAt,
            notes || null,
            actor.id,
            previousStaffUserId,
            shiftPreset ?? null,
          ]
        );

        if (!result.rows.length) {
          throw new StaffScheduleConflictError(
            "Schicht wurde zwischenzeitlich geändert."
          );
        }

        return result.rows[0];
      }
    );

    if (!shift) {
      return res.status(404).json({
        ok: false,
        error: "Schicht oder Mitarbeiter nicht gefunden.",
      });
    }

    return res.json({
      ok: true,
      shift,
    });
  } catch (error: any) {
    if (error instanceof StaffScheduleConflictError) {
      return res.status(409).json({
        ok: false,
        error: error.message,
      });
    }

    if (error?.code === "23P01") {
      return res.status(409).json({
        ok: false,
        error: "Überschneidung mit einer anderen Schicht.",
      });
    }

    console.error("V51 UPDATE SHIFT", error);
    return res.status(500).json({
      ok: false,
      error: "Schicht konnte nicht geändert werden.",
    });
  }
});

/**
 * ALO V51 – Alle Entwürfe einer Woche veröffentlichen.
 *
 * weekStart / weekEnd: ISO-8601-Zeitpunkte mit
 * explizitem Schweizer UTC-Offset.
 *
 * Beispiel Winter:
 * 2026-10-26T00:00:00+01:00
 * 2026-11-02T00:00:00+01:00
 */
router.post("/shifts/publish-week", async (req, res) => {
  try {
    const actor = getStaffUser(res);

    if (!canManageSchedule(actor)) {
      return res.status(403).json({
        ok: false,
        error: "Keine Planungsberechtigung.",
      });
    }

    const rawStart = req.body?.weekStart;
    const rawEnd = req.body?.weekEnd;

    if (
      typeof rawStart !== "string" ||
      typeof rawEnd !== "string"
    ) {
      return res.status(400).json({
        ok: false,
        error: "Wochenbeginn und Wochenende fehlen.",
      });
    }

    const isoWithOffset =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

    if (
      !isoWithOffset.test(rawStart) ||
      !isoWithOffset.test(rawEnd)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Zeitpunkte müssen einen UTC-Offset enthalten.",
      });
    }

    const weekStart = new Date(rawStart);
    const weekEnd = new Date(rawEnd);

    const duration = weekEnd.getTime() - weekStart.getTime();

    if (
      !Number.isFinite(weekStart.getTime()) ||
      !Number.isFinite(weekEnd.getTime()) ||
      duration < 6 * 24 * 60 * 60 * 1000 ||
      duration > 8 * 24 * 60 * 60 * 1000
    ) {
      return res.status(400).json({
        ok: false,
        error: "Ungültiger Wochenzeitraum.",
      });
    }

    // Prüft Schweizer Montag-zu-Montag-Wochen,
    // einschliesslich Sommer-/Winterzeitwechsel.
    const zurichParts = (date: Date) => {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Zurich",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(date);

      return Object.fromEntries(
        parts.map((part) => [part.type, part.value])
      );
    };

    const startParts = zurichParts(weekStart);
    const endParts = zurichParts(weekEnd);

    const startDay = Date.UTC(
      Number(startParts.year),
      Number(startParts.month) - 1,
      Number(startParts.day)
    );

    const endDay = Date.UTC(
      Number(endParts.year),
      Number(endParts.month) - 1,
      Number(endParts.day)
    );

    const isMidnight = (parts: Record<string, string>) =>
      parts.hour === "00" &&
      parts.minute === "00" &&
      parts.second === "00";

    if (
      startParts.weekday !== "Mon" ||
      endParts.weekday !== "Mon" ||
      !isMidnight(startParts) ||
      !isMidnight(endParts) ||
      endDay - startDay !== 7 * 24 * 60 * 60 * 1000 ||
      weekStart.getTime() % 1000 !== 0 ||
      weekEnd.getTime() % 1000 !== 0
    ) {
      return res.status(400).json({
        ok: false,
        error: "Bitte eine vollständige Schweizer Kalenderwoche wählen.",
      });
    }

    const client = await db.connect();

    try {
      await client.query("BEGIN");

      // Sperrt alle Mitarbeiter in stabiler Reihenfolge.
      // Auch Mitarbeiter ohne Entwürfe werden gesperrt,
      // damit keine Schicht gleichzeitig eingefügt wird.
      const employees = await client.query(
        `
          SELECT id
          FROM staff_users
          ORDER BY id
        `
      );

      for (const employee of employees.rows) {
        await client.query(
          `
            SELECT id
            FROM staff_users
            WHERE id = $1
            FOR UPDATE
          `,
          [employee.id]
        );
      }

      const result = await client.query(
        `
          UPDATE staff_schedule_shifts
          SET status = 'PUBLISHED',
              published_at = COALESCE(published_at, NOW()),
              updated_by_user_id = $3,
              updated_at = NOW()
          WHERE status = 'DRAFT'
            AND starts_at >= $1
            AND starts_at < $2
          RETURNING *
        `,
        [weekStart, weekEnd, actor.id]
      );

      await client.query("COMMIT");

      return res.json({
        ok: true,
        publishedCount: result.rows.length,
        shifts: result.rows,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("V51 PUBLISH WEEK", error);
    return res.status(500).json({
      ok: false,
      error: "Dienstplanwoche konnte nicht veröffentlicht werden.",
    });
  }
});

router.post("/shifts/:id/publish", async (req, res) => {
  try {
    const actor = getStaffUser(res);
    if (!canManageSchedule(actor)) {
      return res.status(403).json({
        ok: false,
        error: "Keine Planungsberechtigung.",
      });
    }

    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Ungültige Schicht-ID.",
      });
    }

    const result = await db.query(
      `
      UPDATE staff_schedule_shifts
      SET status = 'PUBLISHED',
          published_at = COALESCE(published_at, NOW()),
          updated_by_user_id = $2,
          updated_at = NOW()
      WHERE id = $1
        AND status = 'DRAFT'
      RETURNING *
      `,
      [id, actor.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Kein veröffentlichbarer Entwurf gefunden.",
      });
    }

    return res.json({
      ok: true,
      shift: result.rows[0],
    });
  } catch (error) {
    console.error("V51 PUBLISH SHIFT", error);
    return res.status(500).json({
      ok: false,
      error: "Schicht konnte nicht veröffentlicht werden.",
    });
  }
});

router.delete("/shifts/:id", async (req, res) => {
  try {
    const actor = getStaffUser(res);
    if (!canManageSchedule(actor)) {
      return res.status(403).json({
        ok: false,
        error: "Keine Planungsberechtigung.",
      });
    }

    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Ungültige Schicht-ID.",
      });
    }

    const result = await db.query(
      `
      UPDATE staff_schedule_shifts
      SET status = 'CANCELLED',
          updated_by_user_id = $2,
          updated_at = NOW()
      WHERE id = $1
        AND status <> 'CANCELLED'
      RETURNING id
      `,
      [id, actor.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Aktive Schicht nicht gefunden.",
      });
    }

    return res.json({
      ok: true,
      cancelledId: id,
    });
  } catch (error) {
    console.error("V51 CANCEL SHIFT", error);
    return res.status(500).json({
      ok: false,
      error: "Schicht konnte nicht storniert werden.",
    });
  }
});


/* ALO V51 – Ferien und Freiwünsche */

router.get("/requests", async (_req, res) => {
  try {
    const actor = getStaffUser(res);
    const manager = canManageSchedule(actor);

    const result = await db.query(
      `
      SELECT
        r.id,
        r.staff_user_id AS "staffUserId",
        u.display_name AS "employeeName",
        r.request_type AS "requestType",
        r.starts_at AS "startsAt",
        r.ends_at AS "endsAt",
        r.reason,
        r.status,
        r.review_note AS "reviewNote",
        r.created_at AS "createdAt"
      FROM staff_schedule_requests r
      JOIN staff_users u ON u.id = r.staff_user_id
      WHERE $1::boolean = TRUE
         OR r.staff_user_id = $2
      ORDER BY r.created_at DESC
      LIMIT 300
      `,
      [manager, actor.id]
    );

    return res.json({
      ok: true,
      requests: result.rows,
    });
  } catch (error) {
    console.error("V51 LIST REQUESTS", error);
    return res.status(500).json({
      ok: false,
      error: "Anträge konnten nicht geladen werden.",
    });
  }
});

router.post("/requests", async (req, res) => {
  try {
    const actor = getStaffUser(res);
    const requestType = String(req.body?.requestType ?? "");
    const startsAt = new Date(req.body?.startsAt);
    const endsAt = new Date(req.body?.endsAt);
    const reason = String(req.body?.reason ?? "").trim();

    if (
      !["VACATION", "DAY_OFF", "UNAVAILABLE"].includes(requestType) ||
      !Number.isFinite(startsAt.getTime()) ||
      !Number.isFinite(endsAt.getTime()) ||
      startsAt >= endsAt ||
      reason.length > 1000
    ) {
      return res.status(400).json({
        ok: false,
        error: "Ungültiger Antrag.",
      });
    }

    const result = await db.query(
      `
      INSERT INTO staff_schedule_requests (
        staff_user_id,
        request_type,
        starts_at,
        ends_at,
        reason
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        actor.id,
        requestType,
        startsAt,
        endsAt,
        reason || null,
      ]
    );

    return res.status(201).json({
      ok: true,
      request: result.rows[0],
    });
  } catch (error) {
    console.error("V51 CREATE REQUEST", error);
    return res.status(500).json({
      ok: false,
      error: "Antrag konnte nicht erstellt werden.",
    });
  }
});

router.patch("/requests/:id/review", async (req, res) => {
  try {
    const actor = getStaffUser(res);

    if (!canManageSchedule(actor)) {
      return res.status(403).json({
        ok: false,
        error: "Keine Berechtigung zur Genehmigung.",
      });
    }

    const id = Number(req.params.id);
    const status = String(req.body?.status ?? "");
    const reviewNote = String(req.body?.reviewNote ?? "").trim();

    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !["APPROVED", "REJECTED"].includes(status) ||
      reviewNote.length > 1000
    ) {
      return res.status(400).json({
        ok: false,
        error: "Ungültige Entscheidung.",
      });
    }

    const existing = await db.query(
      `
        SELECT staff_user_id
        FROM staff_schedule_requests
        WHERE id = $1
          AND status = 'PENDING'
      `,
      [id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Offener Antrag nicht gefunden.",
      });
    }

    const staffUserId = Number(
      existing.rows[0].staff_user_id
    );

    const reviewed = await withStaffScheduleTransaction(
      staffUserId,
      async (client) => {
        const current = await client.query(
          `
            SELECT
              staff_user_id,
              starts_at,
              ends_at
            FROM staff_schedule_requests
            WHERE id = $1
              AND status = 'PENDING'
            FOR UPDATE
          `,
          [id]
        );

        if (!current.rows.length) {
          return null;
        }

        const request = current.rows[0];

        if (Number(request.staff_user_id) !== staffUserId) {
          throw new StaffScheduleConflictError(
            "Antrag wurde zwischenzeitlich geändert."
          );
        }

        if (status === "APPROVED") {
          const conflict = await client.query(
            `
              SELECT id
              FROM staff_schedule_shifts
              WHERE staff_user_id = $1
                AND status <> 'CANCELLED'
                AND starts_at < $3
                AND ends_at > $2
              LIMIT 1
            `,
            [
              staffUserId,
              request.starts_at,
              request.ends_at,
            ]
          );

          if (conflict.rows.length) {
            throw new StaffScheduleConflictError(
              "Antrag überschneidet sich mit einer geplanten Schicht."
            );
          }
        }

        const result = await client.query(
          `
            UPDATE staff_schedule_requests
            SET status = $2,
                reviewed_by_user_id = $3,
                reviewed_at = NOW(),
                review_note = $4,
                updated_at = NOW()
            WHERE id = $1
              AND status = 'PENDING'
            RETURNING *
          `,
          [
            id,
            status,
            actor.id,
            reviewNote || null,
          ]
        );

        return result.rows[0] ?? null;
      }
    );

    if (!reviewed) {
      return res.status(404).json({
        ok: false,
        error: "Offener Antrag nicht gefunden.",
      });
    }

    return res.json({
      ok: true,
      request: reviewed,
    });
  } catch (error: any) {
    if (error instanceof StaffScheduleConflictError) {
      return res.status(409).json({
        ok: false,
        error: error.message,
      });
    }

    console.error("V51 REVIEW REQUEST", error);
    return res.status(500).json({
      ok: false,
      error: "Antrag konnte nicht bearbeitet werden.",
    });
  }
});

export default router;

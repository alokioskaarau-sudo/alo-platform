import { db } from "../../database/db.js";

// ALO_V49F_SAFE_WORKER
// Expo ticket status=ok means accepted by Expo, NOT confirmed delivery to phone.
// Crash after Expo accepts and before DB writes can still cause duplicate delivery.
const INTERVAL_MS = 60_000;
const MAX_ATTEMPTS = 5;
const EXPO_URL = "https://exp.host/--/api/v2/push/send";
let running = false;

type Reminder = {
  id: string;
  event_id: string;
  staff_user_id: string;
  title: string;
  starts_at: Date | string;
  attempts: number;
};
type Delivery = {
  id: string;
  push_token_id: string;
  expo_push_token: string;
};

async function claimDueReminders(): Promise<Reminder[]> {
  const result = await db.query<Reminder>(`
    WITH selected AS (
      SELECT r.id
      FROM staff_calendar_reminders r
      JOIN staff_calendar_events e ON e.id = r.event_id
      WHERE r.status IN ('PENDING', 'FAILED')
        AND r.remind_at <= NOW()
        AND r.attempts < $1
        AND e.cancelled_at IS NULL
        AND e.starts_at > NOW()
        AND (
          r.status = 'PENDING'
          OR r.updated_at < NOW() -
            (LEAST(POWER(2, r.attempts)::integer, 60) * INTERVAL '1 minute')
        )
      ORDER BY r.remind_at ASC
      LIMIT 5
      FOR UPDATE OF r SKIP LOCKED
    )
    UPDATE staff_calendar_reminders r
    SET status = 'PROCESSING',
        attempts = r.attempts + 1,
        updated_at = NOW()
    FROM selected, staff_calendar_events e
    WHERE r.id = selected.id AND e.id = r.event_id
    RETURNING r.id, r.event_id, r.staff_user_id, r.attempts,
              e.title, e.starts_at
  `, [MAX_ATTEMPTS]);
  return result.rows;
}

async function isEventUpcoming(eventId: string): Promise<boolean> {
  const result = await db.query(`
    SELECT 1 FROM staff_calendar_events
    WHERE id = $1 AND cancelled_at IS NULL AND starts_at > NOW()
  `, [eventId]);
  return (result.rowCount ?? 0) > 0;
}

async function ensureDeliveries(reminder: Reminder): Promise<void> {
  // Existing SENT records are preserved across retries; no repeat to accepted tokens.
  await db.query(`
    INSERT INTO staff_calendar_reminder_deliveries (reminder_id, push_token_id)
    SELECT $1, p.id
    FROM staff_push_tokens p
    WHERE p.staff_user_id = $2 AND p.active = TRUE
    ON CONFLICT (reminder_id, push_token_id) DO NOTHING
  `, [reminder.id, reminder.staff_user_id]);
}

async function getPendingDeliveries(reminder: Reminder): Promise<Delivery[]> {
  const result = await db.query<Delivery>(`
    SELECT d.id, d.push_token_id, p.expo_push_token
    FROM staff_calendar_reminder_deliveries d
    JOIN staff_push_tokens p ON p.id = d.push_token_id
    WHERE d.reminder_id = $1
      AND d.status <> 'SENT'
      AND d.attempts < $2
      AND p.staff_user_id = $3
      AND p.active = TRUE
    ORDER BY d.id
  `, [reminder.id, MAX_ATTEMPTS, reminder.staff_user_id]);
  return result.rows;
}

async function sendToDevice(reminder: Reminder, delivery: Delivery): Promise<void> {
  // Last-minute recheck prevents sends for cancelled or already-started events.
  if (!(await isEventUpcoming(reminder.event_id))) return;
  await db.query(`
    UPDATE staff_calendar_reminder_deliveries
    SET attempts = attempts + 1, updated_at = NOW()
    WHERE id = $1 AND status <> 'SENT'
  `, [delivery.id]);
  try {
    const response = await fetch(EXPO_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        to: delivery.expo_push_token,
        sound: 'default',
        title: 'ALO Kalender · Erinnerung',
        body: reminder.title,
        data: {
          type: 'CALENDAR_REMINDER',
          eventId: String(reminder.event_id),
          screen: 'calendar',
        },
        priority: 'high',
      }]),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Expo HTTP ${response.status}`);
    const payload: any = await response.json();
    const tickets = payload?.data;
    if (!Array.isArray(tickets) || tickets.length !== 1) {
      throw new Error('Expo: unvollstaendige Ticket-Antwort');
    }
    const ticket = tickets[0];
    if (ticket?.status !== 'ok') {
      const code = String(ticket?.details?.error || ticket?.message || 'EXPO_REJECTED');
      if (code === 'DeviceNotRegistered') {
        await db.query(`
          UPDATE staff_push_tokens
          SET active = FALSE, disabled_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND expo_push_token = $2
        `, [delivery.push_token_id, delivery.expo_push_token]);
      }
      throw new Error(code);
    }
    await db.query(`
      UPDATE staff_calendar_reminder_deliveries
      SET status = 'SENT', accepted_at = NOW(), last_error = NULL,
          updated_at = NOW()
      WHERE id = $1
    `, [delivery.id]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.query(`
      UPDATE staff_calendar_reminder_deliveries
      SET status = 'FAILED', last_error = $2, updated_at = NOW()
      WHERE id = $1 AND status <> 'SENT'
    `, [delivery.id, message.slice(0, 500)]);
    console.error('ALO Kalender Push fehlgeschlagen', {
      reminderId: reminder.id,
      deliveryId: delivery.id,
      error: message,
    });
  }
}

async function finalizeReminder(reminder: Reminder): Promise<void> {
  const status = await db.query<{
    total: string;
    pending: string;
    accepted: string;
  }>(`
    SELECT COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE status <> 'SENT')::text AS pending,
           COUNT(*) FILTER (WHERE status = 'SENT')::text AS accepted
    FROM staff_calendar_reminder_deliveries WHERE reminder_id = $1
  `, [reminder.id]);
  const counts = status.rows[0];
  const complete = Number(counts?.total || 0) > 0 && Number(counts?.pending || 0) === 0;
  const upcoming = await isEventUpcoming(reminder.event_id);
  if (complete) {
    await db.query(`
      UPDATE staff_calendar_reminders
      SET status = 'SENT', sent_at = NOW(), last_error = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'PROCESSING'
    `, [reminder.id]);
  } else {
    const reason = !upcoming ? 'EVENT_EXPIRED_OR_CANCELLED'
      : Number(counts?.total || 0) === 0 ? 'NO_ACTIVE_PUSH_TOKENS'
      : 'SOME_DEVICE_DELIVERIES_FAILED';
    await db.query(`
      UPDATE staff_calendar_reminders
      SET status = 'FAILED', last_error = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'PROCESSING'
    `, [reminder.id, reason]);
  }
}

async function processBatch(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Reclaim abandoned rows, including those that exhausted MAX_ATTEMPTS.
    await db.query(`
      UPDATE staff_calendar_reminders
      SET status = 'FAILED', last_error = 'WORKER_TIMEOUT', updated_at = NOW()
      WHERE status = 'PROCESSING'
        AND updated_at < NOW() - INTERVAL '30 minutes'
    `);
    const due = await claimDueReminders();
    for (const reminder of due) {
      try {
        if (await isEventUpcoming(reminder.event_id)) {
          await ensureDeliveries(reminder);
          const deliveries = await getPendingDeliveries(reminder);
          for (const delivery of deliveries) {
            if (!(await isEventUpcoming(reminder.event_id))) break;
            await sendToDevice(reminder, delivery);
          }
        }
        await finalizeReminder(reminder);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('ALO Kalender Worker Fehler', reminder.id, message);
        await db.query(`
          UPDATE staff_calendar_reminders
          SET status = 'FAILED', last_error = $2, updated_at = NOW()
          WHERE id = $1 AND status = 'PROCESSING'
        `, [reminder.id, message.slice(0, 500)]);
      }
    }
  } catch (error) {
    console.error('ALO Kalender Reminder Worker:', error);
  } finally {
    running = false;
  }
}

export function startCalendarReminderWorker(): void {
  void processBatch();
  const timer = setInterval(() => { void processBatch(); }, INTERVAL_MS);
  timer.unref();
  console.log('ALO Kalender Reminder Worker V49F gestartet.');
}

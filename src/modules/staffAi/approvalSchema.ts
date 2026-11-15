import { db } from "../../database/db.js";

export async function ensureStaffAiApprovalSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS staff_ai_approval_requests (
      id UUID PRIMARY KEY,
      requester_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (
          status IN (
            'PENDING',
            'APPROVED',
            'REJECTED',
            'EXECUTING',
            'EXECUTED',
            'FAILED'
          )
        ),
      reviewer_id TEXT,
      review_note TEXT,
      reviewed_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ,
      execution_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    ALTER TABLE staff_ai_approval_requests
    ADD COLUMN IF NOT EXISTS idempotency_key UUID
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      staff_ai_approval_requests_requester_idempotency_uidx
    ON staff_ai_approval_requests (requester_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_ai_approval_requests_status_created_idx
    ON staff_ai_approval_requests (
      status,
      created_at DESC
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_ai_approval_requests_requester_idx
    ON staff_ai_approval_requests (
      requester_id,
      created_at DESC
    )
  `);
}

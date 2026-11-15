import { randomUUID } from "node:crypto";
import { Router } from "express";
import { db } from "../database/db.js";
import { getStaffUser, requireStaffAuth } from "../middleware/staffAuth.js";
import { hasStaffCapability } from "../middleware/staffRbac.js";
import { ensureStaffAiApprovalSchema } from "../modules/staffAi/approvalSchema.js";

const router = Router();
router.use(requireStaffAuth);

function isAdmin(res: Parameters<typeof getStaffUser>[0]): boolean {
  return getStaffUser(res).role === "ADMIN";
}

router.post("/requests", async (req, res) => {
  try {
    const staff = getStaffUser(res);
    const productId = req.body?.productId;
    const quantity = req.body?.quantity;
    const reason = req.body?.reason;
    const idempotencyKey = req.body?.idempotencyKey;

    if (
      !Number.isSafeInteger(productId) || productId <= 0 ||
      !Number.isSafeInteger(quantity) || quantity < 0 ||
      typeof idempotencyKey !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey) ||
      typeof reason !== "string" || reason.trim().length < 5 ||
      reason.trim().length > 1000
    ) {
      res.status(422).json({ ok: false, error: "Ungueltiger Antrag." });
      return;
    }

    if (!hasStaffCapability(staff, "inventory.adjust")) {
      res.status(403).json({ ok: false, error: "Keine Berechtigung fuer Bestandskorrekturen." });
      return;
    }

    if (!staff.allowedWorkspaces.includes("ONLINE")) {
      res.status(403).json({ ok: false, error: "Kein Zugriff auf Online-Lager." });
      return;
    }

    await ensureStaffAiApprovalSchema();
    const result = await db.query(
      `SELECT id, title, shopify_inventory_item_id FROM products WHERE id = $1 LIMIT 1`,
      [productId]
    );
    const product = result.rows[0];
    if (!product) {
      res.status(404).json({ ok: false, error: "Produkt nicht gefunden." });
      return;
    }
    if (!product.shopify_inventory_item_id) {
      res.status(409).json({ ok: false, error: "Keine Shopify-Lagerverknuepfung." });
      return;
    }

    const id = randomUUID();
    const payload = {
      productId,
      productTitle: String(product.title ?? ""),
      inventoryItemId: String(product.shopify_inventory_item_id),
      workspace: "online",
      quantity
    };
    const inserted = await db.query(
      `INSERT INTO staff_ai_approval_requests
        (id, requester_id, action_type, payload, reason, idempotency_key)
      VALUES ($1, $2, 'INVENTORY_SET_ONLINE', $3::jsonb, $4, $5::uuid)
      ON CONFLICT (requester_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
      DO NOTHING
      RETURNING id`,
      [id, staff.id, JSON.stringify(payload), reason.trim(), idempotencyKey]
    );
    if (!inserted.rows[0]) {
      const existing = await db.query(
        `SELECT id, status, payload, reason FROM staff_ai_approval_requests
         WHERE requester_id = $1 AND idempotency_key = $2::uuid LIMIT 1`,
        [staff.id, idempotencyKey]
      );
      const previous = existing.rows[0];
      if (!previous) {
        res.status(409).json({ ok: false, error: "Antrag wird bereits verarbeitet. Bitte erneut versuchen." });
        return;
      }
      const p = previous.payload;
      if (previous.reason !== reason.trim() || p?.productId !== productId ||
          p?.quantity !== quantity || p?.inventoryItemId !== payload.inventoryItemId ||
          p?.workspace !== payload.workspace || p?.productTitle !== payload.productTitle) {
        res.status(409).json({ ok: false, error: "Bestaetigungsschluessel gehoert zu einem anderen Antrag." });
        return;
      }
      res.status(200).json({ ok: true, reused: true, request: previous });
      return;
    }

    res.status(201).json({ ok: true, request: { id, status: "PENDING", payload, reason: reason.trim() } });
  } catch (error) {
    console.error("ALO approval create:", error);
    res.status(500).json({ ok: false, error: "Antrag konnte nicht erstellt werden." });
  }
});

router.get("/requests", async (_req, res) => {
  try {
    const staff = getStaffUser(res);
    await ensureStaffAiApprovalSchema();
    const result = isAdmin(res)
      ? await db.query(`SELECT * FROM staff_ai_approval_requests ORDER BY created_at DESC LIMIT 100`)
      : await db.query(
          `SELECT * FROM staff_ai_approval_requests WHERE requester_id = $1 ORDER BY created_at DESC LIMIT 100`,
          [staff.id]
        );
    res.json({ ok: true, requests: result.rows });
  } catch (error) {
    console.error("ALO approval list:", error);
    res.status(500).json({ ok: false, error: "Antraege konnten nicht geladen werden." });
  }
});

router.get("/requests/pending-count", async (_req, res) => {
  try {
    if (!isAdmin(res)) {
      res.status(403).json({ ok: false, error: "Nur fuer Admins." });
      return;
    }
    await ensureStaffAiApprovalSchema();
    const result = await db.query(
      `SELECT COUNT(*)::integer AS count FROM staff_ai_approval_requests WHERE status = 'PENDING'`
    );
    res.json({ ok: true, count: result.rows[0]?.count ?? 0 });
  } catch (error) {
    console.error("ALO approval count:", error);
    res.status(500).json({ ok: false, error: "Anzahl konnte nicht geladen werden." });
  }
});

router.post("/requests/:id/decision", async (req, res) => {
  try {
    if (!isAdmin(res)) {
      res.status(403).json({ ok: false, error: "Nur Admins duerfen entscheiden." });
      return;
    }
    const decision = req.body?.decision;
    const note = req.body?.note ?? "";
    if (
      (decision !== "APPROVE" && decision !== "REJECT") ||
      typeof note !== "string" || note.trim().length > 1000
    ) {
      res.status(422).json({ ok: false, error: "Ungueltige Entscheidung." });
      return;
    }
    await ensureStaffAiApprovalSchema();
    const status = decision === "APPROVE" ? "APPROVED" : "REJECTED";
    const result = await db.query(
      `UPDATE staff_ai_approval_requests
       SET status = $1, reviewer_id = $2, review_note = $3,
           reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $4 AND status = 'PENDING'
       RETURNING *`,
      [status, getStaffUser(res).id, note.trim() || null, req.params.id]
    );
    if (!result.rows[0]) {
      res.status(409).json({ ok: false, error: "Antrag nicht gefunden oder bereits entschieden." });
      return;
    }
    res.json({ ok: true, request: result.rows[0], execution: "NOT_EXECUTED" });
  } catch (error) {
    console.error("ALO approval decision:", error);
    res.status(500).json({ ok: false, error: "Entscheidung konnte nicht gespeichert werden." });
  }
});

export default router;

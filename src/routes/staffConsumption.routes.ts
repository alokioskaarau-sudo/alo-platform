import { Router } from "express";
import { db } from "../database/db.js";
import { requireStaffAuth, getStaffUser } from "../middleware/staffAuth.js";

const router = Router();
router.use(requireStaffAuth);
const workspaces = new Set(["AARAU", "OLTEN", "ONLINE"]);
const canUseWorkspace = (user: ReturnType<typeof getStaffUser>, workspace: string) =>
  user.role === "ADMIN" || user.role === "MANAGER" ||
  [user.defaultWorkspace, ...(user.allowedWorkspaces || [])].some(w => String(w).toUpperCase() === workspace);

let schemaPromise: Promise<void> | undefined;
function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.query(`CREATE TABLE IF NOT EXISTS staff_consumption (
        id BIGSERIAL PRIMARY KEY,
        request_id UUID NOT NULL UNIQUE,
        staff_user_id BIGINT NOT NULL REFERENCES staff_users(id),
        product_id BIGINT NOT NULL REFERENCES products(id),
        workspace TEXT NOT NULL CHECK (workspace IN ('AARAU','OLTEN','ONLINE')),
        quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
        note TEXT NOT NULL DEFAULT '',
        product_title_snapshot TEXT NOT NULL,
        barcode_snapshot TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS staff_consumption_workspace_date_idx ON staff_consumption(workspace, created_at DESC)`);
      await db.query(`CREATE INDEX IF NOT EXISTS staff_consumption_user_date_idx ON staff_consumption(staff_user_id, created_at DESC)`);
    })().catch(err => { schemaPromise = undefined; throw err; });
  }
  return schemaPromise;
}

router.post("/", async (req, res) => {
  try {
    const user = getStaffUser(res);
    const workspace = String(req.body?.workspace || "").toUpperCase();
    const productId = String(req.body?.productId ?? "");
    const quantity = Number(req.body?.quantity);
    const requestId = String(req.body?.requestId || "");
    const note = String(req.body?.note ?? "").trim();
    if (!workspaces.has(workspace) || !canUseWorkspace(user, workspace))
      return res.status(403).json({ ok: false, error: "Kein Zugriff auf diesen Standort" });
    if (!/^\d+$/.test(productId) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100 || note.length > 500 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))
      return res.status(400).json({ ok: false, error: "Ungültige Entnahmeangaben" });
    await ensureSchema();
    const product = await db.query("SELECT id,title,barcode FROM products WHERE id=$1", [productId]);
    if (!product.rows.length) return res.status(404).json({ ok: false, error: "Produkt nicht gefunden" });
    const p = product.rows[0];
    const result = await db.query(`INSERT INTO staff_consumption
      (request_id,staff_user_id,product_id,workspace,quantity,note,product_title_snapshot,barcode_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (request_id) DO NOTHING RETURNING *`,
      [requestId,user.id,productId,workspace,quantity,note,p.title,p.barcode]);
    if (result.rows.length) return res.status(201).json({ ok: true, entry: result.rows[0] });
    const existing = await db.query("SELECT * FROM staff_consumption WHERE request_id=$1", [requestId]);
    const entry = existing.rows[0];
    if (String(entry.staff_user_id) !== String(user.id) || String(entry.product_id) !== productId ||
        entry.workspace !== workspace || Number(entry.quantity) !== quantity || entry.note !== note)
      return res.status(409).json({ ok: false, error: "Buchungskennung bereits verwendet" });
    return res.json({ ok: true, entry, duplicate: true });
  } catch (error) {
    console.error("staff consumption create", error);
    return res.status(500).json({ ok: false, error: "Entnahme konnte nicht gespeichert werden" });
  }
});

router.get("/", async (req, res) => {
  try {
    const user = getStaffUser(res);
    const admin = user.role === "ADMIN" || user.role === "MANAGER";
    const workspace = String(req.query.workspace || "").toUpperCase();
    if (workspace && (!workspaces.has(workspace) || !canUseWorkspace(user, workspace)))
      return res.status(403).json({ ok: false, error: "Kein Standortzugriff" });
    const requestedLimit = Number(req.query.limit ?? 50);
    const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(200, requestedLimit)) : 50;
    await ensureSchema();
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (!admin) { params.push(user.id); clauses.push(`c.staff_user_id=$${params.length}`); }
    if (workspace) { params.push(workspace); clauses.push(`c.workspace=$${params.length}`); }
    else if (!admin) {
      const permitted = [user.defaultWorkspace, ...(user.allowedWorkspaces || [])]
        .map(w => String(w).toUpperCase()).filter(w => workspaces.has(w));
      params.push(permitted); clauses.push(`c.workspace = ANY($${params.length}::text[])`);
    }
    params.push(limit);
    const result = await db.query(`SELECT c.*
      FROM staff_consumption c
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY c.created_at DESC,c.id DESC LIMIT $${params.length}`, params);
    return res.json({ ok: true, entries: result.rows, admin });
  } catch (error) {
    console.error("staff consumption list", error);
    return res.status(500).json({ ok: false, error: "Entnahmen konnten nicht geladen werden" });
  }
});

export default router;

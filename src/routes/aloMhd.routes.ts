import { Router } from "express";
import { randomUUID } from "node:crypto";
import { db } from "../database/db.js";
import { getStaffUser, requireStaffAuth } from "../middleware/staffAuth.js";
import { hasStaffCapability } from "../middleware/staffRbac.js";

const router = Router();
router.use(requireStaffAuth);
let schemaReady: Promise<void> | null = null;
function ensureMhdSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`CREATE TABLE IF NOT EXISTS alo_mhd_batches (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        workspace TEXT NOT NULL CHECK (workspace IN ('AARAU','OLTEN','ONLINE')),
        expiry_date DATE NOT NULL,
        date_kind TEXT NOT NULL CHECK (date_kind IN ('MHD','USE_BY')),
        quantity INTEGER NOT NULL CHECK (quantity >= 0),
        lot_code TEXT,
        note TEXT,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.query(`ALTER TABLE alo_mhd_batches ADD COLUMN IF NOT EXISTS request_key TEXT`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS alo_mhd_batches_request_key_idx ON alo_mhd_batches (request_key) WHERE request_key IS NOT NULL`);
      await db.query(`CREATE INDEX IF NOT EXISTS alo_mhd_batches_location_expiry_idx
        ON alo_mhd_batches (workspace, expiry_date)`);
      await db.query(`CREATE TABLE IF NOT EXISTS alo_mhd_actions (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES alo_mhd_batches(id),
        action_type TEXT NOT NULL CHECK (action_type IN ('CHECK','LABEL','DISCOUNT_REVIEW','RELOCATE','REMOVE_FROM_SALE')),
        status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','APPROVED','REJECTED')),
        note TEXT,
        proposed_by TEXT NOT NULL,
        reviewed_by TEXT,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    })().catch(error => { schemaReady = null; throw error; });
  }
  return schemaReady;
}
function workspaceFor(raw: unknown) {
  const w = String(raw ?? '').trim().toUpperCase();
  return w === 'AARAU' || w === 'OLTEN' || w === 'ONLINE' ? w : null;
}
function validDate(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const d = new Date(raw + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === raw;
}
function allowed(res: any, workspace: string) {
  const staff = getStaffUser(res);
  return (staff.allowedWorkspaces ?? []).includes(workspace as 'AARAU'|'OLTEN'|'ONLINE') &&
    hasStaffCapability(staff, 'inventory.view');
}
function canReview(res: any) {
  const staff = getStaffUser(res);
  return staff.role === 'ADMIN' || staff.role === 'MANAGER' ||
    (((staff.jobKeys ?? []).includes('management') || (staff.jobKeys ?? []).includes('store_manager') || staff.jobKey === 'management' || staff.jobKey === 'store_manager') &&
      hasStaffCapability(staff, 'inventory.adjust'));
}
router.get('/api/alo-mhd/batches', async (req,res) => {
  try {
    const workspace = workspaceFor(req.query.workspace);
    if (!workspace) { res.status(400).json({ok:false,error:'Standort erforderlich.'}); return; }
    if (!allowed(res,workspace)) { res.status(403).json({ok:false,error:'Kein Zugriff.'}); return; }
    await ensureMhdSchema();
    const result = await db.query(`SELECT b.*,
      (b.expiry_date - CURRENT_DATE)::int AS days_remaining,
      CASE WHEN b.expiry_date < CURRENT_DATE THEN 'EXPIRED'
           WHEN b.expiry_date <= CURRENT_DATE + 7 THEN 'CRITICAL'
           WHEN b.expiry_date <= CURRENT_DATE + 30 THEN 'SOON'
           ELSE 'OK' END AS urgency
      FROM alo_mhd_batches b WHERE workspace=$1 AND quantity > 0
      ORDER BY expiry_date ASC, created_at DESC LIMIT 500`,[workspace]);
    res.json({ok:true,batches:result.rows});
  } catch(e) { console.error('ALO MHD list',e); res.status(500).json({ok:false,error:'MHD konnte nicht geladen werden.'}); }
});
router.post('/api/alo-mhd/batches', async (req,res) => {
  try {
    const staff = getStaffUser(res);
    const workspace = workspaceFor(req.body?.workspace);
    const productId = String(req.body?.productId ?? '').trim();
    const expiryDate = req.body?.expiryDate;
    const quantity = req.body?.quantity;
    const dateKind = req.body?.dateKind;
    if (!workspace || !allowed(res,workspace)) { res.status(403).json({ok:false,error:'Standort nicht erlaubt.'}); return; }
    if (!productId || productId.length > 100 || !validDate(expiryDate) ||
        !Number.isInteger(quantity) || quantity < 0 || quantity > 1000000 ||
        (dateKind !== 'MHD' && dateKind !== 'USE_BY')) {
      res.status(400).json({ok:false,error:'Ungültige Produkt-, Mengen- oder MHD-Daten.'}); return;
    }
    await ensureMhdSchema();
    const exists = await db.query('SELECT id FROM products WHERE id::text=$1 LIMIT 1',[productId]);
    if (!exists.rowCount) { res.status(404).json({ok:false,error:'Produkt nicht gefunden.'}); return; }
    const lotCode = String(req.body?.lotCode ?? '').trim().slice(0,100) || null;
    const note = String(req.body?.note ?? '').trim().slice(0,500) || null;
    const requestKey = req.body?.requestKey == null ? null : String(req.body.requestKey).trim();
    if (requestKey !== null && (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestKey))) {
      res.status(400).json({ok:false,error:'Ungültiger Erfassungsschlüssel.'}); return;
    }
    // Die gleiche Produkt-/Standortkombination wird seriell verarbeitet.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const stockStore = workspace.toLowerCase();
      // Auch ohne vorhandenen Snapshot werden parallele MHD-Erfassungen gesperrt.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [productId, stockStore]);
      if (requestKey) {
        const previous = await client.query('SELECT * FROM alo_mhd_batches WHERE request_key=$1', [requestKey]);
        if (previous.rowCount) {
          const b = previous.rows[0];
          if (b.product_id !== productId || b.workspace !== workspace ||
              String(b.expiry_date).slice(0,10) !== expiryDate || Number(b.quantity) !== quantity ||
              b.date_kind !== dateKind || (b.lot_code ?? null) !== lotCode) {
            await client.query('ROLLBACK');
            res.status(409).json({ok:false,error:'Erfassungsschlüssel bereits für andere Daten verwendet.'}); return;
          }
          await client.query('COMMIT');
          res.json({ok:true,batch:b,idempotent:true}); return;
        }
      }
      const stock = await client.query(`SELECT exact_quantity FROM product_stock_snapshots
        WHERE product_id=$1 AND store_id=$2 FOR UPDATE`, [productId,stockStore]);
      const available = stock.rows[0]?.exact_quantity;
      if (available == null || !Number.isInteger(Number(available))) {
        await client.query('ROLLBACK');
        res.status(409).json({ok:false,code:'STOCK_UNKNOWN',error:'Standortbestand unbekannt. Erst Bestand prüfen.'}); return;
      }
      const counted = await client.query(`SELECT COALESCE(SUM(quantity),0)::int AS total
        FROM alo_mhd_batches WHERE product_id=$1 AND workspace=$2`,[productId,workspace]);
      const already = Number(counted.rows[0]?.total ?? 0);
      if (already + quantity > Number(available)) {
        await client.query('ROLLBACK');
        res.status(409).json({ok:false,code:'MHD_EXCEEDS_STOCK',error:'MHD-Mengen übersteigen den Standortbestand.',available:Number(available),alreadyRecorded:already}); return;
      }
      // Schutz vor unmittelbarem Doppelklick, ohne spätere echte Nacherfassung zu sperren.
      const recent = await client.query(`SELECT id FROM alo_mhd_batches WHERE product_id=$1 AND workspace=$2
        AND expiry_date=$3::date AND date_kind=$4 AND quantity=$5
        AND lot_code IS NOT DISTINCT FROM $6::text AND created_by=$7
        AND created_at > NOW() - INTERVAL '20 seconds' LIMIT 1`,
        [productId,workspace,expiryDate,dateKind,quantity,lotCode,String(staff.id)]);
      if (recent.rowCount) {
        await client.query('ROLLBACK');
        res.status(409).json({ok:false,code:'POSSIBLE_DUPLICATE',error:'Diese Charge wurde gerade erfasst. Bitte vorhandene Erfassung prüfen.'}); return;
      }
      const id = randomUUID();
      const result = await client.query(`INSERT INTO alo_mhd_batches
        (id,product_id,workspace,expiry_date,date_kind,quantity,lot_code,note,created_by,request_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [id,productId,workspace,expiryDate,dateKind,quantity,lotCode,note,String(staff.id),requestKey]);
      await client.query('COMMIT');
      res.status(201).json({ok:true,batch:result.rows[0]});
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch(e) { console.error('ALO MHD create',e); res.status(500).json({ok:false,error:'MHD konnte nicht gespeichert werden.'}); }
});
router.post('/api/alo-mhd/actions', async (req,res) => {
  try {
    const staff=getStaffUser(res);
    const batchId=String(req.body?.batchId ?? '');
    const actionType=String(req.body?.actionType ?? '');
    if (!['CHECK','LABEL','DISCOUNT_REVIEW','RELOCATE','REMOVE_FROM_SALE'].includes(actionType)) {
      res.status(400).json({ok:false,error:'Ungültige Aktion.'}); return;
    }
    await ensureMhdSchema();
    const batch=await db.query('SELECT workspace FROM alo_mhd_batches WHERE id=$1',[batchId]);
    if (!batch.rowCount) {res.status(404).json({ok:false,error:'Charge nicht gefunden.'});return;}
    if (!allowed(res,batch.rows[0].workspace)) {res.status(403).json({ok:false,error:'Kein Zugriff.'});return;}
    const id=randomUUID();
    await db.query(`INSERT INTO alo_mhd_actions (id,batch_id,action_type,note,proposed_by)
      VALUES ($1,$2,$3,$4,$5)`,[id,batchId,actionType,String(req.body?.note ?? '').slice(0,500),String(staff.id)]);
    res.status(201).json({ok:true,id,status:'PROPOSED'});
  } catch(e) {console.error('ALO MHD propose',e);res.status(500).json({ok:false,error:'Aktion konnte nicht vorgeschlagen werden.'});}
});
router.get('/api/alo-mhd/actions', async(req,res)=>{
  try {
    const workspace=workspaceFor(req.query.workspace);
    if(!workspace || !allowed(res,workspace)){res.status(403).json({ok:false,error:'Kein Zugriff.'});return;}
    await ensureMhdSchema();
    const r=await db.query(`SELECT a.*,b.workspace,b.product_id,b.expiry_date
      FROM alo_mhd_actions a JOIN alo_mhd_batches b ON b.id=a.batch_id
      WHERE b.workspace=$1 ORDER BY a.created_at DESC LIMIT 200`,[workspace]);
    res.json({ok:true,actions:r.rows});
  }catch(e){console.error('ALO MHD actions',e);res.status(500).json({ok:false,error:'Aktionen konnten nicht geladen werden.'});}
});
router.post('/api/alo-mhd/actions/:id/review',async(req,res)=>{
  try {
    if(!canReview(res)){res.status(403).json({ok:false,error:'Freigabe nur für Leitung.'});return;}
    const status=req.body?.status;
    if(status!=='APPROVED' && status!=='REJECTED'){res.status(400).json({ok:false,error:'Status ungültig.'});return;}
    await ensureMhdSchema();
    const staff=getStaffUser(res);
    const r=await db.query(`UPDATE alo_mhd_actions a SET status=$1,reviewed_by=$2,reviewed_at=NOW()
      FROM alo_mhd_batches b WHERE a.id=$3 AND a.batch_id=b.id AND a.status='PROPOSED'
      AND b.workspace=ANY($4::text[]) RETURNING a.id,a.status`,
      [status,String(staff.id),String(req.params.id),staff.allowedWorkspaces]);
    if(!r.rowCount){res.status(404).json({ok:false,error:'Offene Aktion nicht gefunden.'});return;}
    res.json({ok:true,action:r.rows[0],note:'Freigabe dokumentiert; keine automatische Preis- oder Kassenänderung.'});
  }catch(e){console.error('ALO MHD review',e);res.status(500).json({ok:false,error:'Freigabe fehlgeschlagen.'});}
});
export default router;

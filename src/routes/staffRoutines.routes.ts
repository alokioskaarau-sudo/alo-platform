import { Router } from "express";
import { db } from "../database/db.js";
import { requireStaffAuth, getStaffUser } from "../middleware/staffAuth.js";
import { requireStaffCapability } from "../middleware/staffRbac.js";

const router = Router();
router.use(requireStaffAuth);
const workspaces = new Set(["AARAU", "OLTEN", "ONLINE"]);
const allowed = (user: ReturnType<typeof getStaffUser>, workspace: string) =>
  (user.role === "ADMIN" || user.role === "MANAGER") ||
  [user.defaultWorkspace, ...(user.allowedWorkspaces || [])].some(w => String(w).toUpperCase() === workspace);
const localDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const localWeekday = () => {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Zurich", weekday: "short" }).format(new Date());
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
};
let schemaPromise: Promise<void> | null = null;
function ensureSchema() {
  if (!schemaPromise) schemaPromise = (async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS staff_task_routines (
      id BIGSERIAL PRIMARY KEY, workspace TEXT NOT NULL CHECK (workspace IN ('AARAU','OLTEN','ONLINE')),
      title TEXT NOT NULL, description TEXT, priority TEXT NOT NULL DEFAULT 'NORMAL'
      CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
      frequency TEXT NOT NULL CHECK (frequency IN ('DAILY','WEEKLY')),
      weekday INTEGER CHECK (weekday BETWEEN 0 AND 6),
      created_by_user_id BIGINT NOT NULL REFERENCES staff_users(id),
      active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      active_since DATE NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Zurich')::date,
      CHECK ((frequency = 'DAILY' AND weekday IS NULL) OR (frequency = 'WEEKLY' AND weekday IS NOT NULL))
    )`);
    await db.query(`ALTER TABLE staff_task_routines ADD COLUMN IF NOT EXISTS active_since DATE NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Zurich')::date`);
    await db.query(`CREATE TABLE IF NOT EXISTS staff_task_routine_occurrences (
      routine_id BIGINT NOT NULL REFERENCES staff_task_routines(id) ON DELETE CASCADE,
      local_date DATE NOT NULL, task_id BIGINT NOT NULL UNIQUE REFERENCES staff_tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (routine_id, local_date)
    )`);
  })().catch(e => { schemaPromise = null; throw e; });
  return schemaPromise;
}
async function materialize(workspace: string) {
  // Generate missed days on demand, capped at 30 days. The active_since
  // boundary prevents retroactive tasks for a paused routine.
  const routines = await db.query(`SELECT * FROM staff_task_routines
    WHERE workspace=$1 AND active=TRUE`, [workspace]);
  const today = localDay();
  const todayUtc = Date.parse(`${today}T00:00:00Z`);
  for (const routine of routines.rows) {
    const created = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(routine.created_at));
    const activeSince = String(routine.active_since).slice(0,10).match(/^\d{4}-\d{2}-\d{2}$/)
      ? String(routine.active_since).slice(0,10)
      : new Date(routine.active_since).toISOString().slice(0,10);
    const first = Math.max(todayUtc - 29*86400000, Date.parse(`${created}T00:00:00Z`), Date.parse(`${activeSince}T00:00:00Z`));
    for (let time = first; time <= todayUtc; time += 86400000) {
      const date = new Date(time).toISOString().slice(0,10);
      const weekday = new Date(time).getUTCDay();
      if (routine.frequency === 'WEEKLY' && Number(routine.weekday) !== weekday) continue;
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
          [Number(routine.id) % 2147483647, Number(date.replaceAll('-', ''))]);
        const exists = await client.query(`SELECT 1 FROM staff_task_routine_occurrences
          WHERE routine_id=$1 AND local_date=$2::date`, [routine.id, date]);
        if (!exists.rowCount) {
          const task = await client.query(`INSERT INTO staff_tasks
            (title, description, created_by_user_id, workspace, priority, due_at)
            VALUES ($1,$2,$3,$4,$5,($6::date + INTERVAL '1 day') AT TIME ZONE 'Europe/Zurich') RETURNING id`,
            [routine.title, routine.description, routine.created_by_user_id, routine.workspace, routine.priority, date]);
          await client.query(`INSERT INTO staff_task_routine_occurrences (routine_id, local_date, task_id)
            VALUES ($1,$2,$3)`, [routine.id, date, task.rows[0].id]);
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    }
  }
}
router.get('/', requireStaffCapability('tasks.view'), async (req,res) => {
  try {
    const workspace = String(req.query.workspace || '').toUpperCase();
    const user = getStaffUser(res);
    if (!workspaces.has(workspace)) return res.status(400).json({ok:false,error:'Ungültiger Standort'});
    if (!allowed(user,workspace)) return res.status(403).json({ok:false,error:'Kein Zugriff auf Standort'});
    await ensureSchema();
    await materialize(workspace);
    const routines = await db.query(`SELECT * FROM staff_task_routines WHERE workspace=$1 ORDER BY active DESC,id DESC`,[workspace]);
    const tasks = await db.query(`SELECT t.*,o.local_date,o.routine_id FROM staff_task_routine_occurrences o
      JOIN staff_tasks t ON t.id=o.task_id JOIN staff_task_routines r ON r.id=o.routine_id
      WHERE r.workspace=$1 AND t.archived_at IS NULL ORDER BY o.local_date DESC,o.task_id DESC LIMIT 150`,[workspace]);
    return res.json({ok:true,workspace,routines:routines.rows,tasks:tasks.rows});
  } catch(e) { console.error('routine list',e); return res.status(500).json({ok:false,error:'Routinen konnten nicht geladen werden'}); }
});
router.post('/', requireStaffCapability('tasks.manage'), async (req,res) => {
  try {
    const user=getStaffUser(res);
    const workspace=String(req.body?.workspace||'').toUpperCase();
    const title=String(req.body?.title||'').trim();
    const frequency=String(req.body?.frequency||'').toUpperCase();
    const priority=String(req.body?.priority||'NORMAL').toUpperCase();
    const weekday=frequency==='WEEKLY'?Number(req.body?.weekday):null;
    if (!workspaces.has(workspace)||!allowed(user,workspace)) return res.status(403).json({ok:false,error:'Standort nicht erlaubt'});
    if (!title||title.length>180||!['DAILY','WEEKLY'].includes(frequency)||!['LOW','NORMAL','HIGH','URGENT'].includes(priority)||
      (frequency==='WEEKLY'&&(!Number.isInteger(weekday)||weekday===null||weekday<0||weekday>6)))
      return res.status(400).json({ok:false,error:'Ungültige Routinedaten'});
    await ensureSchema();
    const result=await db.query(`INSERT INTO staff_task_routines
      (workspace,title,description,priority,frequency,weekday,created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [workspace,title,String(req.body?.description||'').slice(0,4000),priority,frequency,weekday,user.id]);
    return res.status(201).json({ok:true,routine:result.rows[0]});
  } catch(e) { console.error('routine create',e); return res.status(500).json({ok:false,error:'Routine konnte nicht erstellt werden'}); }
});
router.patch('/:id/active', requireStaffCapability('tasks.manage'), async (req,res) => {
  try {
    const user=getStaffUser(res);
    const id=String(req.params.id||'');
    if (!/^\d+$/.test(id)||typeof req.body?.active!=='boolean') return res.status(400).json({ok:false,error:'Ungültige Eingabe'});
    await ensureSchema();
    const old=await db.query('SELECT workspace FROM staff_task_routines WHERE id=$1',[id]);
    if (!old.rows.length) return res.status(404).json({ok:false,error:'Routine nicht gefunden'});
    if (!allowed(user,old.rows[0].workspace)) return res.status(403).json({ok:false,error:'Kein Standortzugriff'});
    const result=await db.query(`UPDATE staff_task_routines SET active=$2,
      active_since=CASE WHEN active=FALSE AND $2=TRUE THEN (NOW() AT TIME ZONE 'Europe/Zurich')::date ELSE active_since END
      WHERE id=$1 RETURNING *`,[id,req.body.active]);
    return res.json({ok:true,routine:result.rows[0]});
  } catch(e) { console.error('routine active',e); return res.status(500).json({ok:false,error:'Routine konnte nicht aktualisiert werden'}); }
});
export default router;

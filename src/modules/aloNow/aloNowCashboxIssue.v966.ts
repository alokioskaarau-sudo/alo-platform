/** ALO NOW V966. Issue custody and open driver shift in ONE SQL transaction.
 * Staging only. Route must authenticate/authorize staff and validate driver.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../../database/db.js';

type Workspace = 'AARAU' | 'OLTEN';
type Actor = {actorUserId:string; workspace:Workspace; manager:boolean};
const positiveText=(v:string,max=180)=> typeof v==='string'&&v.trim().length>0&&v.trim().length<=max;
const cash=(v:number)=>Number.isSafeInteger(v)&&v>=0;

export async function issueCashboxAndOpenShiftV966(
  actor:Actor, driverUserId:string, cashboxCode:string, openingFloatRappen:number
):Promise<{custodyId:string;shiftId:string;status:'ISSUED'}> {
  if(!actor?.manager||!positiveText(actor.actorUserId)||
     (actor.workspace!=='AARAU'&&actor.workspace!=='OLTEN'))throw new Error('MANAGER_REQUIRED');
  if(!positiveText(driverUserId)||
     !positiveText(cashboxCode,80)||!cash(openingFloatRappen))throw new Error('INVALID_CASHBOX_ISSUE');
  const c=await db.connect();
  try {
    await c.query('BEGIN');
    // One driver cannot receive two concurrent boxes/shifts, even during retries.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',
      ['ALO-NOW-CASHBOX-ISSUE:'+driverUserId]);
    const custodyId=randomUUID(),shiftId=randomUUID();
    await c.query(`INSERT INTO alo_now_cash_custody_v958
      (id,cashbox_code,driver_user_id,issued_by_user_id,workspace,opening_float_rappen,status)
      VALUES ($1,$2,$3,$4,$5,$6,'ISSUED')`,
      [custodyId,cashboxCode.trim(),driverUserId,actor.actorUserId,actor.workspace,openingFloatRappen]);
    await c.query(`INSERT INTO alo_now_driver_cash_shifts
      (id,driver_user_id,workspace,opening_cash_rappen,status)
      VALUES ($1,$2,$3,$4,'OPEN')`,
      [shiftId,driverUserId,actor.workspace,openingFloatRappen]);
    await c.query(`INSERT INTO alo_now_cash_custody_audit_v958
      (id,custody_id,actor_user_id,action,reference_id,details)
      VALUES ($1,$2,$3,'ISSUED',$4,$5::jsonb)`,
      [randomUUID(),custodyId,actor.actorUserId,shiftId,
       JSON.stringify({cashboxCode:cashboxCode.trim(),openingFloatRappen,shiftId,version:'V966'})]);
    await c.query('COMMIT');
    return {custodyId,shiftId,status:'ISSUED'};
  } catch(e) {try{await c.query('ROLLBACK');}catch{} throw e;}
  finally {c.release();}
}

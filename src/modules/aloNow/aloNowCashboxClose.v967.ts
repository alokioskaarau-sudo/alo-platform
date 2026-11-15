/** V967: Fail-closed, atomic custody and shift closure. Test/staging only. */
import { randomUUID } from 'node:crypto';
import { db } from '../../database/db.js';
import { calculateCashShiftSummary } from './aloNowFinancePolicy.v842.js';
import type { FinanceEventType, FinanceEvent } from './aloNowDriverFinance.v841.js';
type Workspace='AARAU'|'OLTEN';
type Manager={actorUserId:string; workspace:Workspace; manager:boolean};
const amount=(s:string)=>{const n=Number(s);if(!Number.isSafeInteger(n)||n<0)throw Error('INVALID_STORED_AMOUNT');return n;};
export async function closeCashboxAndShiftV967(actor:Manager,custodyId:string,shiftId:string,countedFloatRappen:number,emptyOnlyV2153=false){
 if(!actor?.manager||!actor.actorUserId?.trim()||!['AARAU','OLTEN'].includes(actor.workspace))throw Error('MANAGER_REQUIRED');
 if(!/^[0-9a-f-]{36}$/i.test(custodyId)||!/^[0-9a-f-]{36}$/i.test(shiftId)||!Number.isSafeInteger(countedFloatRappen)||countedFloatRappen<0)throw Error('INVALID_CLOSE_INPUT');
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const r=await c.query<{id:string;driver_user_id:string;workspace:Workspace;status:string;opening_float_rappen:string}>(`SELECT id,driver_user_id,workspace,status,opening_float_rappen::text FROM alo_now_cash_custody_v958 WHERE id=$1 FOR UPDATE`,[custodyId]);
  const custody=r.rows[0];
  if(!custody||custody.workspace!==actor.workspace)throw Error('CUSTODY_NOT_FOUND');
  const selfCloseV2153=custody.driver_user_id===actor.actorUserId;
  if(selfCloseV2153 && !emptyOnlyV2153)throw Error('INDEPENDENT_COUNTER_REQUIRED');
  if(custody.status!=='RETURN_PENDING')throw Error('CUSTODY_RETURN_NOT_REQUESTED');
  const sr=await c.query<{id:string;driver_user_id:string;workspace:Workspace;status:string;opening_cash_rappen:string}>(`SELECT id,driver_user_id,workspace,status,opening_cash_rappen::text FROM alo_now_driver_cash_shifts WHERE id=$1 FOR UPDATE`,[shiftId]);
  const shift=sr.rows[0];
  if(!shift||shift.driver_user_id!==custody.driver_user_id||shift.workspace!==custody.workspace)throw Error('SHIFT_CUSTODY_MISMATCH');
  // ALO_NOW_V975_CUSTODY_SHIFT_BINDING
  // A shift must be linked to this exact custody by its issue audit.
  const binding=await c.query<{matches:string}>(`
    SELECT COUNT(*)::text AS matches
    FROM alo_now_cash_custody_audit_v958
    WHERE custody_id=$1
      AND action='ISSUED'
      AND reference_id=$2::uuid
  `,[custodyId,shiftId]);

  if(binding.rows[0]?.matches!=='1')
    throw Error('CUSTODY_SHIFT_BINDING_REQUIRED');

  if(shift.status!=='OPEN')throw Error('SHIFT_NOT_OPEN');
  const float=amount(custody.opening_float_rappen);
  if(float!==amount(shift.opening_cash_rappen))throw Error('OPENING_FLOAT_MISMATCH');
  const pending=await c.query<{n:string}>(`SELECT count(*)::text AS n FROM alo_now_cash_envelopes_v958 WHERE custody_id=$1 AND status='DECLARED'`,[custodyId]);
  if(Number(pending.rows[0]?.n??0)!==0)throw Error('ENVELOPES_PENDING_COUNT');
  const er=await c.query<{event_key:string;event_type:FinanceEventType;amount_rappen:string}>(`SELECT event_key,event_type,amount_rappen::text FROM alo_now_driver_finance_events WHERE cash_shift_id=$1 ORDER BY created_at,id`,[shiftId]);
  const events:FinanceEvent[]=er.rows.map(e=>({eventKey:e.event_key,type:e.event_type,amountRappen:Number(e.amount_rappen)}));
  // V2153: Exception only for a genuinely unused cashbox, counted at original float.
  // A self-count is recorded in the audit, never treated as independent verification.
  if(emptyOnlyV2153){
    if(events.length!==0)throw Error('EMPTY_CASHBOX_HAS_FINANCE_EVENTS');
    const envelopes=await c.query<{n:string}>(
      `SELECT COUNT(*)::text AS n FROM alo_now_cash_envelopes_v958 WHERE custody_id=$1`,[custodyId]);
    if(envelopes.rows[0]?.n!=='0')throw Error('EMPTY_CASHBOX_HAS_ENVELOPES');
    if(!/^[1-9][0-9]{0,18}$/.test(custody.driver_user_id))throw Error('INVALID_DRIVER_ID');
    const deliveries=await c.query<{n:string}>(
      `SELECT COUNT(*)::text AS n FROM alo_now_deliveries
       WHERE assigned_driver_user_id=$1::bigint AND fulfillment_workspace=$2
         AND assigned_at >= (SELECT issued_at FROM alo_now_cash_custody_v958 WHERE id=$3)
         AND delivery_status <> 'CANCELLED'`,
      [custody.driver_user_id,custody.workspace,custodyId]);
    if(deliveries.rows[0]?.n!=='0')throw Error('EMPTY_CASHBOX_HAS_DELIVERIES');
  }
  const summary=calculateCashShiftSummary(float,events,countedFloatRappen);
  // All order cash must already be handed over. No silent offset against commission or float.
  if(summary.expectedRappen!==float)throw Error('FINANCE_RECONCILIATION_REQUIRED');
  if(countedFloatRappen!==float)throw Error('OPENING_FLOAT_DIFFERENCE_REQUIRES_MANUAL_REVIEW');
  const shiftUpdate=await c.query(`UPDATE alo_now_driver_cash_shifts SET status='CLOSED',closed_at=NOW(),closed_by_user_id=$2,closing_expected_rappen=$3,closing_counted_rappen=$4,closing_difference_rappen=0 WHERE id=$1 AND status='OPEN'`,[shiftId,actor.actorUserId,float,countedFloatRappen]);
  if(shiftUpdate.rowCount!==1)throw Error('SHIFT_UPDATE_CONFLICT');
  const custodyUpdate=await c.query(`UPDATE alo_now_cash_custody_v958 SET status='CLOSED',returned_at=NOW(),closed_by_user_id=$2,returned_float_rappen=$3,closing_note='V967: fully reconciled' WHERE id=$1 AND status='RETURN_PENDING'`,[custodyId,actor.actorUserId,countedFloatRappen]);
  if(custodyUpdate.rowCount!==1)throw Error('CUSTODY_UPDATE_CONFLICT');
  await c.query(`INSERT INTO alo_now_cash_custody_audit_v958(id,custody_id,actor_user_id,action,reference_id,details) VALUES($1,$2,$3,'CLOSED',$4,$5::jsonb)`,[randomUUID(),custodyId,actor.actorUserId,shiftId,JSON.stringify({version:emptyOnlyV2153?'V2153':'V967',countedFloatRappen,expectedRappen:float,selfCounted:selfCloseV2153,emptyOnly:emptyOnlyV2153})]);
  await c.query('COMMIT');
  return {custodyId,shiftId,status:'CLOSED' as const,expectedFloatRappen:float,countedFloatRappen,differenceRappen:0};
 }catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}finally{c.release();}
}

/**
 * ALO NOW V960 – atomic envelope counting + V841 ledger handover.
 * STAGING CANDIDATE ONLY. Not an HTTP route; caller MUST derive the actor,
 * workspace and manager role from an authenticated staff session.
 * No wage/payroll deductions or order-payment confirmation.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../../database/db.js';
import { validateCashLedger } from './aloNowFinancePolicy.v842.js';
import type { FinanceEvent, FinanceEventType } from './aloNowDriverFinance.v841.js';

type Workspace = 'AARAU' | 'OLTEN';
type ManagerContext = {actorUserId:string; workspace:Workspace; manager:boolean};
type CustodyRow = {id:string; driver_user_id:string; workspace:Workspace; status:string; opening_float_rappen:string};
type EnvelopeRow = {id:string; declared_by_user_id:string; declared_rappen:string; counted_rappen:string|null; status:string};
type ShiftRow = {id:string; driver_user_id:string; workspace:Workspace; status:string; opening_cash_rappen:string};
const int=(x:number)=>Number.isSafeInteger(x)&&x>=0;
const fromDb=(x:string)=>{const n=Number(x);if(!int(n))throw new Error('INVALID_STORED_RAPPEN');return n;};
const signedFromDb=(x:string)=>{const n=Number(x);if(!Number.isSafeInteger(n))throw new Error('INVALID_STORED_RAPPEN');return n;};

export async function countEnvelopeAndBookHandoverV960(
  actor:ManagerContext,
  custodyId:string,
  envelopeId:string,
  shiftId:string,
  countedRappen:number
):Promise<{envelopeId:string;countedRappen:number;differenceRappen:number;ledgerEventId:string|null;alreadyConfirmed:boolean}> {
  if(!actor || !actor.manager || !actor.actorUserId?.trim())throw new Error('MANAGER_REQUIRED');
  if(actor.workspace!=='AARAU' && actor.workspace!=='OLTEN')throw new Error('INVALID_WORKSPACE');
  if(!custodyId?.trim() || !envelopeId?.trim() || !shiftId?.trim())throw new Error('INVALID_REFERENCE');
  if(!int(countedRappen))throw new Error('INVALID_RAPPEN');
  const eventKey=`ALO-ENVELOPE-COUNTED:${envelopeId}`;
  const c:PoolClient=await db.connect();
  try {
    await c.query('BEGIN');
    const cr=await c.query<CustodyRow>(
      `SELECT id,driver_user_id,workspace,status,opening_float_rappen::text
       FROM alo_now_cash_custody_v958 WHERE id=$1 FOR UPDATE`,[custodyId]);
    const custody=cr.rows[0];
    if(!custody || custody.workspace!==actor.workspace)throw new Error('CUSTODY_NOT_FOUND');
    if(!['ACTIVE','RETURN_PENDING'].includes(custody.status))throw new Error('WRONG_CUSTODY_STATE');
    if(custody.driver_user_id===actor.actorUserId)throw new Error('INDEPENDENT_COUNTER_REQUIRED');
    const er=await c.query<EnvelopeRow>(
      `SELECT id,declared_by_user_id,declared_rappen::text,counted_rappen::text,status
       FROM alo_now_cash_envelopes_v958 WHERE id=$1 AND custody_id=$2 FOR UPDATE`,
      [envelopeId,custodyId]);
    const envelope=er.rows[0];
    if(!envelope)throw new Error('ENVELOPE_NOT_FOUND');
    if(envelope.declared_by_user_id===actor.actorUserId)throw new Error('INDEPENDENT_COUNTER_REQUIRED');
    const declared=fromDb(envelope.declared_rappen);
    const difference=countedRappen-declared;
    if(!Number.isSafeInteger(difference))throw new Error('AMOUNT_OVERFLOW');

    const sr=await c.query<ShiftRow>(
      `SELECT id,driver_user_id,workspace,status,opening_cash_rappen::text
       FROM alo_now_driver_cash_shifts WHERE id=$1 FOR UPDATE`,[shiftId]);
    const shift=sr.rows[0];
    if(!shift || shift.driver_user_id!==custody.driver_user_id || shift.workspace!==custody.workspace)
      throw new Error('CASH_SHIFT_MISMATCH');
    if(shift.status!=='OPEN')throw new Error('CASH_SHIFT_ALREADY_CLOSED');
    if(fromDb(shift.opening_cash_rappen)!==fromDb(custody.opening_float_rappen))
      throw new Error('OPENING_FLOAT_MISMATCH');

    const existing=await c.query<{id:string;event_type:string;amount_rappen:string;cash_shift_id:string;source_reference:string}>(
      `SELECT id,event_type,amount_rappen::text,cash_shift_id,source_reference
       FROM alo_now_driver_finance_events WHERE event_key=$1`,[eventKey]);
    const old=existing.rows[0];
    if(envelope.status==='COUNTED'){
      if(envelope.counted_rappen===null || fromDb(envelope.counted_rappen)!==countedRappen)
        throw new Error('ENVELOPE_IDEMPOTENCY_CONFLICT');
      if(countedRappen>0 && (!old || old.event_type!=='CASH_HANDOVER_OUT' ||
         old.amount_rappen!==String(countedRappen) || old.cash_shift_id!==shiftId ||
         old.source_reference!==envelopeId))throw new Error('LEDGER_RECONCILIATION_REQUIRED');
      if(countedRappen===0 && old)throw new Error('ZERO_HANDOVER_EVENT_UNEXPECTED');
      await c.query('COMMIT');
      return {envelopeId,countedRappen,differenceRappen:difference,ledgerEventId:old?.id??null,alreadyConfirmed:true};
    }
    if(envelope.status!=='DECLARED')throw new Error('WRONG_ENVELOPE_STATE');
    if(old)throw new Error('LEDGER_RECONCILIATION_REQUIRED');

    const historyResult=await c.query<{event_key:string;event_type:FinanceEventType;amount_rappen:string}>(
      `SELECT event_key,event_type,amount_rappen::text FROM alo_now_driver_finance_events
       WHERE cash_shift_id=$1 ORDER BY created_at,id`,[shiftId]);
    const history:FinanceEvent[]=historyResult.rows.map(r=>({eventKey:r.event_key,type:r.event_type,amountRappen:signedFromDb(r.amount_rappen)}));
    const opening=fromDb(shift.opening_cash_rappen);
    validateCashLedger(opening,countedRappen>0?[...history,{eventKey,type:'CASH_HANDOVER_OUT',amountRappen:countedRappen}]:history);

    let ledgerEventId:string|null=null;
    if(countedRappen>0){
      ledgerEventId=randomUUID();
      await c.query(
        `INSERT INTO alo_now_driver_finance_events
         (id,event_key,driver_user_id,workspace,cash_shift_id,order_id,event_type,
          amount_rappen,source_reference,actor_user_id,reason)
         VALUES ($1,$2,$3,$4,$5,NULL,'CASH_HANDOVER_OUT',$6,$7,$8,NULL)`,
        [ledgerEventId,eventKey,custody.driver_user_id,custody.workspace,shiftId,countedRappen,envelopeId,actor.actorUserId]);
    }
    const updated=await c.query(
      `UPDATE alo_now_cash_envelopes_v958 SET status='COUNTED',counted_by_user_id=$3,
       counted_rappen=$4,counted_at=NOW(),difference_rappen=$5
       WHERE id=$1 AND custody_id=$2 AND status='DECLARED'`,
      [envelopeId,custodyId,actor.actorUserId,countedRappen,difference]);
    if(updated.rowCount!==1)throw new Error('ENVELOPE_UPDATE_CONFLICT');
    await c.query(
      `INSERT INTO alo_now_cash_custody_audit_v958
       (id,custody_id,actor_user_id,action,reference_id,details)
       VALUES ($1,$2,$3,'ENVELOPE_COUNTED',$4,$5::jsonb)`,
      [randomUUID(),custodyId,actor.actorUserId,envelopeId,JSON.stringify({countedRappen,differenceRappen:difference,ledgerEventId,shiftId})]);
    await c.query('COMMIT');
    return {envelopeId,countedRappen,differenceRappen:difference,ledgerEventId,alreadyConfirmed:false};
  }catch(error){try{await c.query('ROLLBACK');}catch{}throw error;}
  finally{c.release();}
}

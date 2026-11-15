/** ALO NOW V958 – cashbox and envelope chain-of-custody.
 * Staging only. Not an API: the route layer MUST authenticate staff, derive actor id
 * from the session, authorize managers and workspace, and rate-limit mutations.
 * NEVER use this as proof of financial settlement, wage deduction or order payment.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../../database/db.js';

type Workspace='AARAU'|'OLTEN';
type Authority={actorUserId:string;workspace:Workspace;manager:boolean};
const valid=(v:number)=>Number.isSafeInteger(v)&&v>=0;
function assertAmount(n:number){if(!valid(n))throw new Error('INVALID_RAPPEN');}
function assertText(s:string,max=80){if(typeof s!=='string'||!s.trim()||s.trim().length>max)throw new Error('INVALID_IDENTIFIER');}
function assertCtx(a:Authority){assertText(a.actorUserId,180);if(a.workspace!=='AARAU'&&a.workspace!=='OLTEN')throw new Error('INVALID_WORKSPACE');}
function requireManager(a:Authority){assertCtx(a);if(!a.manager)throw new Error('MANAGER_REQUIRED');}
async function tx<T>(f:(c:PoolClient)=>Promise<T>):Promise<T>{const c=await db.connect();try{await c.query('BEGIN');const v=await f(c);await c.query('COMMIT');return v;}catch(e){try{await c.query('ROLLBACK')}catch{}throw e;}finally{c.release();}}
type Custody={id:string;cashbox_code:string;driver_user_id:string;issued_by_user_id:string;workspace:Workspace;opening_float_rappen:string;status:'ISSUED'|'ACTIVE'|'RETURN_PENDING'|'CLOSED'};
async function lock(c:PoolClient,id:string,a:Authority):Promise<Custody>{const r=await c.query<Custody>('SELECT id,cashbox_code,driver_user_id,issued_by_user_id,workspace,opening_float_rappen::text, status FROM alo_now_cash_custody_v958 WHERE id=$1 FOR UPDATE',[id]);const x=r.rows[0];if(!x||x.workspace!==a.workspace)throw new Error('CUSTODY_NOT_FOUND');return x;}
async function audit(c:PoolClient,id:string,actor:string,action:string,details:object,referenceId:string|null=null){await c.query('INSERT INTO alo_now_cash_custody_audit_v958(id,custody_id,actor_user_id,action,reference_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[randomUUID(),id,actor,action,referenceId,JSON.stringify(details)]);}
export async function issueCashboxV958(a:Authority,driverUserId:string,cashboxCode:string,floatRappen:number){requireManager(a);assertText(driverUserId,180);assertText(cashboxCode);assertAmount(floatRappen);if(driverUserId===a.actorUserId)throw new Error('SELF_ISSUE_FORBIDDEN');return tx(async c=>{const id=randomUUID();await c.query('INSERT INTO alo_now_cash_custody_v958(id,cashbox_code,driver_user_id,issued_by_user_id,workspace,opening_float_rappen) VALUES($1,$2,$3,$4,$5,$6)',[id,cashboxCode.trim(),driverUserId,a.actorUserId,a.workspace,floatRappen]);await audit(c,id,a.actorUserId,'ISSUED',{cashboxCode,floatRappen});return {id,status:'ISSUED' as const};});}
export async function acceptCashboxV958(a:Authority,id:string){assertCtx(a);return tx(async c=>{const x=await lock(c,id,a);if(x.driver_user_id!==a.actorUserId)throw new Error('DRIVER_ONLY');if(x.status!=='ISSUED')throw new Error('WRONG_CUSTODY_STATE');await c.query("UPDATE alo_now_cash_custody_v958 SET status='ACTIVE',accepted_at=NOW(),accepted_by_driver_user_id=$2 WHERE id=$1",[id,a.actorUserId]);await audit(c,id,a.actorUserId,'ACCEPTED',{});return {id,status:'ACTIVE' as const};});}
export async function declareEnvelopeV958(a:Authority,id:string,envelopeCode:string,amountRappen:number){assertCtx(a);assertText(envelopeCode);assertAmount(amountRappen);return tx(async c=>{const x=await lock(c,id,a);if(x.driver_user_id!==a.actorUserId)throw new Error('DRIVER_ONLY');if(x.status!=='ACTIVE')throw new Error('WRONG_CUSTODY_STATE');const envelopeId=randomUUID();await c.query('INSERT INTO alo_now_cash_envelopes_v958(id,custody_id,envelope_code,declared_by_user_id,declared_rappen) VALUES($1,$2,$3,$4,$5)',[envelopeId,id,envelopeCode.trim(),a.actorUserId,amountRappen]);await audit(c,id,a.actorUserId,'ENVELOPE_DECLARED',{declaredRappen:amountRappen,envelopeCode},envelopeId);return {envelopeId,status:'DECLARED' as const};});}
export async function countEnvelopeV958(a:Authority,id:string,envelopeId:string,countedRappen:number){requireManager(a);assertAmount(countedRappen);return tx(async c=>{const x=await lock(c,id,a);if(x.status!=='ACTIVE'&&x.status!=='RETURN_PENDING')throw new Error('WRONG_CUSTODY_STATE');const e=await c.query<{declared_by_user_id:string;declared_rappen:string;status:string}>('SELECT declared_by_user_id,declared_rappen::text,status FROM alo_now_cash_envelopes_v958 WHERE id=$1 AND custody_id=$2 FOR UPDATE',[envelopeId,id]);const v=e.rows[0];if(!v)throw new Error('ENVELOPE_NOT_FOUND');if(v.status!=='DECLARED')throw new Error('ENVELOPE_ALREADY_COUNTED');if(v.declared_by_user_id===a.actorUserId)throw new Error('INDEPENDENT_COUNTER_REQUIRED');const declared=Number(v.declared_rappen);if(!valid(declared))throw new Error('INVALID_STORED_AMOUNT');const difference=countedRappen-declared;await c.query("UPDATE alo_now_cash_envelopes_v958 SET status='COUNTED',counted_by_user_id=$3,counted_rappen=$4,counted_at=NOW(),difference_rappen=$5 WHERE id=$1 AND custody_id=$2",[envelopeId,id,a.actorUserId,countedRappen,difference]);await audit(c,id,a.actorUserId,'ENVELOPE_COUNTED',{countedRappen,differenceRappen:difference},envelopeId);return {envelopeId,status:'COUNTED' as const,differenceRappen:difference};});}
export async function requestCashboxReturnV958(a:Authority,id:string){assertCtx(a);return tx(async c=>{const x=await lock(c,id,a);if(x.driver_user_id!==a.actorUserId)throw new Error('DRIVER_ONLY');if(x.status!=='ACTIVE')throw new Error('WRONG_CUSTODY_STATE');await c.query("UPDATE alo_now_cash_custody_v958 SET status='RETURN_PENDING',return_requested_at=NOW() WHERE id=$1",[id]);await audit(c,id,a.actorUserId,'RETURN_REQUESTED',{});return {id,status:'RETURN_PENDING' as const};});}
export async function closeCashboxV958(a:Authority,id:string,countedFloatRappen:number,note:string){requireManager(a);assertAmount(countedFloatRappen);if(typeof note!=='string'||note.length>2000)throw new Error('INVALID_NOTE');return tx(async c=>{const x=await lock(c,id,a);if(x.status!=='RETURN_PENDING')throw new Error('WRONG_CUSTODY_STATE');if(x.driver_user_id===a.actorUserId)throw new Error('INDEPENDENT_COUNTER_REQUIRED');const pending=await c.query<{count:string}>("SELECT COUNT(*)::text AS count FROM alo_now_cash_envelopes_v958 WHERE custody_id=$1 AND status='DECLARED'",[id]);if(Number(pending.rows[0]?.count??0)>0)throw new Error('ENVELOPES_PENDING_COUNT');const expected=Number(x.opening_float_rappen);if(!valid(expected))throw new Error('INVALID_STORED_AMOUNT');const diff=countedFloatRappen-expected;if(diff!==0&&!note.trim())throw new Error('DIFFERENCE_REASON_REQUIRED');await c.query("UPDATE alo_now_cash_custody_v958 SET status='CLOSED',returned_at=NOW(),closed_by_user_id=$2,returned_float_rappen=$3,closing_note=$4 WHERE id=$1",[id,a.actorUserId,countedFloatRappen,note]);await audit(c,id,a.actorUserId,'CLOSED',{countedFloatRappen,floatDifferenceRappen:diff,note});return {id,status:'CLOSED' as const,floatDifferenceRappen:diff,financeSettlementConfirmed:false};});}


// ALO_V2104_ADMIN_RETURN_REQUEST: status transition only; never a cash settlement.
// ALO_V2230_ADMIN_CASH_RETURN_ISSUED_ACTIVE
export async function requestCashboxReturnByAdminV2104(a:Authority,id:string){
  requireManager(a);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw Error('INVALID_CUSTODY_ID');
  return tx(async c=>{
    const x=await lock(c,id,a);
    // V2147: Admin may request return of own driver cashbox; no cash is settled here.
    // Independent verification remains enforced by the separate close operation.
    // Repeated admin request is idempotent: no duplicate audit or money movement.
    if(x.status==='RETURN_PENDING')
      return {custodyId:id,status:'RETURN_PENDING' as const,cashReceived:false,alreadyPending:true};
    if(x.status!=='ACTIVE' && x.status!=='ISSUED') throw Error('CUSTODY_NOT_ACTIVE');
    const updated=await c.query(
      `UPDATE alo_now_cash_custody_v958 SET status='RETURN_PENDING',return_requested_at=NOW() WHERE id=$1 AND workspace=$2 AND status IN ('ACTIVE','ISSUED') RETURNING id`,
      [id,a.workspace]
    );
    if(updated.rowCount!==1) throw Error('CUSTODY_UPDATE_CONFLICT');
    await audit(c,id,a.actorUserId,'RETURN_REQUESTED',{
      initiatedBy:'ADMIN', driverUserId:x.driver_user_id,
      previousStatus:x.status, nextStatus:'RETURN_PENDING',
      cashReceived:false, independentlyCounted:false
    });
    return {custodyId:id,status:'RETURN_PENDING' as const,cashReceived:false};
  });
}

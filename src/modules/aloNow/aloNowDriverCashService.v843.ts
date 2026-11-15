// ALO NOW V843 - transactional cash ledger, not yet exposed by API.
// Caller must authenticate and authorize employee and workspace.
// Money values are integer CHF rappen.

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "../../database/db.js";
import {
  calculateCashShiftSummary,
  validateCashLedger,
} from "./aloNowFinancePolicy.v842.js";
import type {
  FinanceEvent,
  FinanceEventType,
} from "./aloNowDriverFinance.v841.js";

type Workspace = "AARAU" | "OLTEN";

type ShiftRow = {
  id:string;
  driver_user_id:string;
  workspace:Workspace;
  status:"OPEN"|"CLOSED";
  opening_cash_rappen:string;
};

type EventInput = {
  eventKey:string;
  type:FinanceEventType;
  amountRappen:number;
  sourceReference:string;
  orderId?:string|null;
  reason?:string|null;
};

type Context = {
  driverUserId:string;
  actorUserId:string;
  workspace:Workspace;
};

function checkContext(ctx:Context):void {
  if (
    !ctx.driverUserId?.trim() ||
    !ctx.actorUserId?.trim() ||
    !["AARAU","OLTEN"].includes(ctx.workspace)
  ) throw new Error("INVALID_FINANCE_CONTEXT");
}

function money(value:number):void {
  if(!Number.isSafeInteger(value) || value<0)
    throw new Error("INVALID_MONEY");
}

async function transaction<T>(
  work:(client:PoolClient)=>Promise<T>
):Promise<T>{
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const result=await work(client);
    await client.query("COMMIT");
    return result;
  }catch(error){
    try{await client.query("ROLLBACK");}catch{}
    throw error;
  }finally{
    client.release();
  }
}

async function lockShift(
  client:PoolClient,
  shiftId:string,
  ctx:Context
):Promise<ShiftRow>{
  const result=await client.query<ShiftRow>(`
    SELECT id,driver_user_id,workspace,status,
           opening_cash_rappen::text AS opening_cash_rappen
    FROM alo_now_driver_cash_shifts
    WHERE id=$1
    FOR UPDATE
  `,[shiftId]);

  const shift=result.rows[0];
  if(!shift || shift.driver_user_id!==ctx.driverUserId ||
     shift.workspace!==ctx.workspace)
    throw new Error("CASH_SHIFT_NOT_FOUND_OR_FORBIDDEN");

  return shift;
}

async function readShiftEvents(
  client:PoolClient,
  shiftId:string
):Promise<FinanceEvent[]>{
  const result=await client.query<{
    event_key:string;
    event_type:FinanceEventType;
    amount_rappen:string;
  }>(`
    SELECT event_key,event_type,
           amount_rappen::text AS amount_rappen
    FROM alo_now_driver_finance_events
    WHERE cash_shift_id=$1
    ORDER BY created_at ASC,id ASC
  `,[shiftId]);

  return result.rows.map(row=>{
    const amount=Number(row.amount_rappen);
    if(!Number.isSafeInteger(amount))
      throw new Error("FINANCE_AMOUNT_OVERFLOW");
    return {
      eventKey:row.event_key,
      type:row.event_type,
      amountRappen:amount,
    };
  });
}

export async function openDriverCashShiftV843(
  ctx:Context,
  openingCashRappen:number
){
  checkContext(ctx);
  money(openingCashRappen);

  return transaction(async client=>{
    // Enforced additionally by the partial unique index in V841.
    const id=randomUUID();
    const result=await client.query<{id:string}>(`
      INSERT INTO alo_now_driver_cash_shifts
        (id,driver_user_id,workspace,opening_cash_rappen)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (driver_user_id)
        WHERE status='OPEN'
      DO NOTHING
      RETURNING id
    `,[id,ctx.driverUserId,ctx.workspace,openingCashRappen]);

    if(!result.rows[0])
      throw new Error("DRIVER_ALREADY_HAS_OPEN_CASH_SHIFT");

    return {shiftId:id,status:"OPEN" as const};
  });
}

export async function bookDriverFinanceEventV843(
  ctx:Context,
  shiftId:string,
  event:EventInput
){
  checkContext(ctx);

  if(
    !event.eventKey?.trim() ||
    event.eventKey.length>180 ||
    !event.sourceReference?.trim() ||
    event.sourceReference.length>250 ||
    !Number.isSafeInteger(event.amountRappen) ||
    (event.type==="CASH_ADJUSTMENT"
      ? event.amountRappen===0
      : event.amountRappen<=0)
  ) throw new Error("INVALID_FINANCE_EVENT");

  const allowed:FinanceEventType[]=[
    "COMMISSION_EARNED",
    "CASH_ORDER_COLLECTED",
    "CASH_TIP_COLLECTED",
    "ONLINE_TIP_EARNED",
    "TIP_PAYOUT",
    "CASH_HANDOVER_IN",
    "CASH_HANDOVER_OUT",
    "CASH_ADJUSTMENT",
  ];
  if(!allowed.includes(event.type))
    throw new Error("UNKNOWN_FINANCE_EVENT");

  // Corrections must always have a documented reason.
  if(event.type==="CASH_ADJUSTMENT" &&
     !event.reason?.trim())
    throw new Error("ADJUSTMENT_REASON_REQUIRED");

  return transaction(async client=>{
    const shift=await lockShift(client,shiftId,ctx);

    // Check idempotency after locking, including events of other shifts.
    const previous=await client.query<{
      id:string;
      cash_shift_id:string;
      driver_user_id:string;
      event_type:string;
      amount_rappen:string;
      source_reference:string;
      order_id:string|null;
    }>(`
      SELECT id,cash_shift_id,driver_user_id,
             event_type,amount_rappen::text AS amount_rappen,
             source_reference,order_id
      FROM alo_now_driver_finance_events
      WHERE event_key=$1
    `,[event.eventKey]);

    if(previous.rows[0]){
      const old=previous.rows[0];
      if(
        old.cash_shift_id!==shiftId ||
        old.driver_user_id!==ctx.driverUserId ||
        old.event_type!==event.type ||
        old.amount_rappen!==String(event.amountRappen) ||
        old.source_reference!==event.sourceReference ||
        old.order_id!==(event.orderId??null)
      ) throw new Error("FINANCE_EVENT_IDEMPOTENCY_CONFLICT");

      return {eventId:old.id,alreadyBooked:true};
    }

    if(shift.status!=="OPEN")
      throw new Error("CASH_SHIFT_ALREADY_CLOSED");

    const history=await readShiftEvents(client,shiftId);
    const proposed:FinanceEvent={
      eventKey:event.eventKey,
      type:event.type,
      amountRappen:event.amountRappen,
    };

    const opening=Number(shift.opening_cash_rappen);
    money(opening);
    validateCashLedger(opening,[...history,proposed]);

    const eventId=randomUUID();
    await client.query(`
      INSERT INTO alo_now_driver_finance_events
        (id,event_key,driver_user_id,workspace,
         cash_shift_id,order_id,event_type,
         amount_rappen,source_reference,
         actor_user_id,reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `,[
      eventId,event.eventKey,ctx.driverUserId,
      ctx.workspace,shiftId,event.orderId??null,
      event.type,event.amountRappen,
      event.sourceReference,ctx.actorUserId,
      event.reason??null
    ]);

    return {eventId,alreadyBooked:false};
  });
}

export async function closeDriverCashShiftV843(
  ctx:Context,
  shiftId:string,
  countedCashRappen:number
){
  checkContext(ctx);
  money(countedCashRappen);

  return transaction(async client=>{
    const shift=await lockShift(client,shiftId,ctx);

    if(shift.status!=="OPEN")
      throw new Error("CASH_SHIFT_ALREADY_CLOSED");

    const opening=Number(shift.opening_cash_rappen);
    money(opening);

    const events=await readShiftEvents(client,shiftId);
    const summary=calculateCashShiftSummary(
      opening,events,countedCashRappen
    );

    await client.query(`
      UPDATE alo_now_driver_cash_shifts
      SET status='CLOSED',
          closed_at=NOW(),
          closed_by_user_id=$2,
          closing_expected_rappen=$3,
          closing_counted_rappen=$4,
          closing_difference_rappen=$5
      WHERE id=$1 AND status='OPEN'
    `,[
      shiftId,ctx.actorUserId,
      summary.expectedRappen,
      summary.countedRappen,
      summary.differenceRappen
    ]);

    return {shiftId,status:"CLOSED" as const,...summary};
  });
}


// ALO_NOW_V929_ATOMIC_CASH_BUNDLE
// Internal ledger primitive only. NOT an HTTP payment endpoint.
// Caller must perform trusted delivery/payment verification.
export async function bookCashBundleV929(
  ctx:Context,
  shiftId:string,
  orderId:string,
  orderRappen:number,
  tipRappen:number
) {
  checkContext(ctx);
  money(orderRappen);
  money(tipRappen);

  if (
    !orderId.trim() ||
    orderId.length > 180 ||
    orderRappen <= 0 ||
    !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(orderId)
  ) throw new Error("INVALID_CASH_BUNDLE");

  return transaction(async client => {
    // ALO_NOW_V930_ORDER_LOCK
    // Transaction-scoped lock shared across all driver shifts.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      ["ALO-NOW-CASH-COLLECTION:" + orderId]
    );

    const shift=await lockShift(client,shiftId,ctx);

    if (shift.status !== "OPEN")
      throw new Error("CASH_SHIFT_ALREADY_CLOSED");

    // Prevent two collections on the same order even
    // when they are attempted from different cash shifts.
    const existing = await client.query<{
      event_type:string;
    }>(`
      SELECT event_type
      FROM alo_now_driver_finance_events
      WHERE order_id=$1
        AND event_type IN (
          'CASH_ORDER_COLLECTED',
          'CASH_TIP_COLLECTED'
        )
      FOR UPDATE
    `,[orderId]);

    if (existing.rows.length)
      throw new Error("CASH_ORDER_ALREADY_BOOKED");

    const events = await readShiftEvents(client,shiftId);

    const orderKey = "ALO-CASH-ORDER:" + orderId;
    const tipKey = "ALO-CASH-TIP:" + orderId;

    const proposed:FinanceEvent[] = [
      {
        eventKey:orderKey,
        type:"CASH_ORDER_COLLECTED",
        amountRappen:orderRappen
      },
      ...(tipRappen > 0 ? [{
        eventKey:tipKey,
        type:"CASH_TIP_COLLECTED" as const,
        amountRappen:tipRappen
      }] : [])
    ];

    const opening = Number(shift.opening_cash_rappen);
    money(opening);
    validateCashLedger(opening,[...events,...proposed]);

    const inserted:string[]=[];

    for (const event of proposed) {
      const id=randomUUID();

      await client.query(`
        INSERT INTO alo_now_driver_finance_events
          (id,event_key,driver_user_id,workspace,
           cash_shift_id,order_id,event_type,
           amount_rappen,source_reference,
           actor_user_id,reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,[
        id,event.eventKey,ctx.driverUserId,
        ctx.workspace,shiftId,orderId,event.type,
        event.amountRappen,orderId,ctx.actorUserId,
        null
      ]);

      inserted.push(id);
    }

    return {
      orderId,
      shiftId,
      orderRappen,
      tipRappen,
      eventIds:inserted
    };
  });
}

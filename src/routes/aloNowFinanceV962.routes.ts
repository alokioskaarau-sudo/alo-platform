import { requestCashboxReturnByAdminV2104 } from "../modules/aloNow/aloNowCashCustody.v958.js"; // ALO_V2104_ADMIN_RETURN_REQUEST
import { randomUUID as financeCashboxUUID } from "node:crypto";

import {
  acceptCashboxV958,
  requestCashboxReturnV958,
} from "../modules/aloNow/aloNowCashCustody.v958.js";
/**
 * ALO NOW V962 - read-only finance and custody API.
 * No payments, settlements or mutations.
 */

import { Router } from "express";
import { db } from "../database/db.js";
import { readDriverWalletCandidatesV1678 } from "../modules/aloNow/aloNowWalletReader.v1678.js";

import {
  getStaffUser,
  requireStaffAuth,
} from "../middleware/staffAuth.js";

export const aloNowFinanceV962Router = Router();

const noStore = (_req: any, res: any, next: any) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};

const money = (value: unknown): string => {
  const v = String(value);
  if (!/^(0|[1-9]\d*)$/.test(v)) {
    throw new Error("INVALID_STORED_AMOUNT");
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new Error("FINANCE_AMOUNT_OVERFLOW");
  }
  return v;
};

aloNowFinanceV962Router.use(requireStaffAuth, noStore);

// ALO_NOW_V963_DRIVER_CASHBOX
// Mutations are OFF by default. Never trust a client-supplied actor ID.
const v963Enabled = () =>
  process.env.NODE_ENV === "production"
    ? process.env.ALO_NOW_DRIVER_CASH_ACTIONS_V2178_ENABLED === "true"
    : process.env.ALO_NOW_FINANCE_MUTATIONS_V963_ENABLED === "true";

const validUuidV963 = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

async function driverCashboxActionV963(
  req: any,
  res: any,
  action: "ACCEPT" | "RETURN"
) {
  if (!v963Enabled()) {
    return res.status(503).json({
      ok: false,
      error: "V963_STAGING_MUTATIONS_DISABLED",
    });
  }

  const staff = getStaffUser(res);

  if (
    !staff.active ||
    !staff.approvedAt ||
    !(
      staff.role === "ADMIN" ||
      staff.jobKey === "driver" ||
      staff.jobKeys.includes("driver")
    )
  ) {
    return res.status(403).json({
      ok: false,
      error: "APPROVED_DRIVER_REQUIRED",
    });
  }

  const custodyId = String(req.params.id ?? "");

  if (!validUuidV963(custodyId)) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_CUSTODY_ID",
    });
  }

  try {
    const result = await db.query<{
      workspace: string;
    }>(
      `SELECT workspace
       FROM alo_now_cash_custody_v958
       WHERE id=$1 AND driver_user_id=$2`,
      [custodyId, staff.id]
    );

    const custody = result.rows[0];

    if (!custody) {
      return res.status(404).json({
        ok: false,
        error: "CUSTODY_NOT_FOUND",
      });
    }

    if (
      custody.workspace !== "AARAU" &&
      custody.workspace !== "OLTEN"
    ) {
      return res.status(409).json({
        ok: false,
        error: "INVALID_CUSTODY_WORKSPACE",
      });
    }

    if (!staff.allowedWorkspaces.includes(custody.workspace)) {
      return res.status(403).json({
        ok: false,
        error: "WORKSPACE_FORBIDDEN",
      });
    }

    const actor: {
      actorUserId: string;
      workspace: "AARAU" | "OLTEN";
      manager: boolean;
    } = {
      actorUserId: staff.id,
      workspace: custody.workspace as "AARAU" | "OLTEN",
      manager: false,
    };

    const data =
      action === "ACCEPT"
        ? await acceptCashboxV958(actor, custodyId)
        : await requestCashboxReturnV958(actor, custodyId);

    return res.json({
      ok: true,
      version: "V963",
      ...data,
    });
  } catch (error) {
    const code =
      error instanceof Error ? error.message : "";

    if (
      code === "WRONG_CUSTODY_STATE" ||
      code === "DRIVER_ONLY" ||
      code === "CUSTODY_NOT_FOUND"
    ) {
      return res.status(409).json({
        ok: false,
        error: code,
      });
    }

    console.error("V963 CASHBOX ACTION FAILED", error);

    return res.status(503).json({
      ok: false,
      error: "CASHBOX_ACTION_UNAVAILABLE",
    });
  }
}

aloNowFinanceV962Router.post(
  "/driver/cashboxes/:id/accept",
  async (req, res) =>
    driverCashboxActionV963(req, res, "ACCEPT")
);

aloNowFinanceV962Router.post(
  "/driver/cashboxes/:id/request-return",
  async (req, res) =>
    driverCashboxActionV963(req, res, "RETURN")
);


/**
 * A driver can read ONLY records assigned to their
 * authenticated staff identity.
 */
aloNowFinanceV962Router.get(
  "/driver/finance-overview",
  async (_req, res) => {
    try {
      const staff = getStaffUser(res);

      const driverAllowed =
        staff.role === "ADMIN" ||
        staff.jobKey === "driver" ||
        staff.jobKeys.includes("driver");

      if (!driverAllowed) {
        return res.status(403).json({
          ok: false,
          error: "DRIVER_ACCESS_REQUIRED",
        });
      }

      // ALO_NOW_V1684_FINANCE_SCOPE
      // Filter legacy finance history by authenticated workspace access.
      const financeAllowedWorkspaces = [
        ...new Set(
          (staff.allowedWorkspaces ?? []).filter(
            (workspace): workspace is "AARAU" | "OLTEN" =>
              workspace === "AARAU" ||
              workspace === "OLTEN"
          )
        )
      ];

      const [custodies, shifts, events] =
        await Promise.all([
          db.query(`
            SELECT
              id, cashbox_code, workspace, status,
              opening_float_rappen::text,
              issued_at, accepted_at,
              return_requested_at, returned_at,
              issued_by_user_id,
              closed_by_user_id,
              returned_float_rappen::text
            FROM alo_now_cash_custody_v958
            WHERE driver_user_id=$1
              AND workspace = ANY($2::text[])
            ORDER BY issued_at DESC
            LIMIT 50
          `, [staff.id, financeAllowedWorkspaces]),

          db.query(`
            SELECT
              id, workspace, status,
              opening_cash_rappen::text,
              opened_at, closed_at,
              closing_expected_rappen::text,
              closing_counted_rappen::text,
              closing_difference_rappen::text
            FROM alo_now_driver_cash_shifts
            WHERE driver_user_id=$1
              AND workspace = ANY($2::text[])
            ORDER BY opened_at DESC
            LIMIT 50
          `, [staff.id, financeAllowedWorkspaces]),

          db.query(`
            SELECT
              id, event_key, event_type,
              workspace, order_id, cash_shift_id,
              amount_rappen::text,
              source_reference, created_at
            FROM alo_now_driver_finance_events
            WHERE driver_user_id=$1
              AND workspace = ANY($2::text[])
            ORDER BY created_at DESC,id DESC
            LIMIT 100
          `, [staff.id, financeAllowedWorkspaces]),
        ]);

      for (const row of custodies.rows) {
        money(row.opening_float_rappen);
        if (row.returned_float_rappen !== null) {
          money(row.returned_float_rappen);
        }
      }

      for (const row of shifts.rows) {
        money(row.opening_cash_rappen);
      }

      for (const row of events.rows) {

      if (
        row.event_type === "CASH_ADJUSTMENT" &&
        /^-?[0-9]+$/.test(String(row.amount_rappen)) &&
        Number.isSafeInteger(Number(row.amount_rappen)) &&
        Number(row.amount_rappen) !== 0
      ) {
        continue;
      }
      money(row.amount_rappen);

      }


        // ALO_NOW_V1681_WALLET_EVIDENCE
        // Discovery only; payout authorization stays disabled.
        const walletDriverId = String(staff.id);

        const walletWorkspaces = (
          staff.allowedWorkspaces ?? []
        ).filter(
          (w): w is "AARAU" | "OLTEN" =>
            w === "AARAU" || w === "OLTEN"
        );

        let walletEvidence: {
          status: string;
          candidates: Awaited<
            ReturnType<typeof readDriverWalletCandidatesV1678>
          >;
          payoutEnabled: false;
          limitedToRecentDeliveries: true;
        } = {
          status: "PENDING_VERIFIED_RECONCILIATION",
          candidates: [],
          payoutEnabled: false,
          limitedToRecentDeliveries: true
        };

        if (!/^[1-9][0-9]{0,18}$/.test(walletDriverId)) {
          walletEvidence.status = "DRIVER_ID_UNSUPPORTED";
        } else if (walletWorkspaces.length === 0) {
          walletEvidence.status = "NO_ALLOWED_WORKSPACE";
        } else {
          try {
            const groups = await Promise.all(
              walletWorkspaces.map(workspace =>
                readDriverWalletCandidatesV1678(
                  async (sql, params) => {
                    if (!/^\s*SELECT\b/i.test(sql)) {
                      throw new Error("WALLET_NOT_READ_ONLY");
                    }
                    const result = await db.query(sql, params);
                    return { rows: result.rows };
                  },
                  walletDriverId,
                  workspace
                )
              )
            );

            walletEvidence = {
              status: "EVIDENCE_DISCOVERY_ONLY",
              candidates: groups.flat(),
              payoutEnabled: false,
              limitedToRecentDeliveries: true
            };
          } catch (error) {
            console.error(
              "V1681 WALLET EVIDENCE READ FAILED",
              error
            );
            walletEvidence = {
              status: "EVIDENCE_UNAVAILABLE",
              candidates: [],
              payoutEnabled: false,
              limitedToRecentDeliveries: true
            };
          }
        }

return res.json({
        ok: true,
        version: "V962",
        currency: "CHF",
        moneyUnit: "RAPPEN",
        driverUserId: staff.id,
        cashboxes: custodies.rows,
        cashShifts: shifts.rows,
        financeEvents: events.rows,
        walletEvidence,
        walletSettlementStatus:
          "PENDING_VERIFIED_RECONCILIATION",
        payableOutstandingRappen: null,
        readOnly: true,
      });
    } catch (error) {
      console.error("V962 DRIVER FINANCE READ FAILED", error);
      return res.status(503).json({
        ok: false,
        error: "DRIVER_FINANCE_UNAVAILABLE",
      });
    }
  }
);

/**
 * Admin / manager: inspect cashboxes only within
 * the workspaces permitted by the staff session.
 */
aloNowFinanceV962Router.get(
  "/admin/cashboxes",
  async (req, res) => {
    try {
      const staff = getStaffUser(res);

      if (
        staff.role !== "ADMIN" &&
        staff.role !== "MANAGER"
      ) {
        return res.status(403).json({
          ok: false,
          error: "MANAGEMENT_ACCESS_REQUIRED",
        });
      }

      const workspace = String(
        req.query.workspace ?? ""
      ).trim().toUpperCase();

      if (
        workspace !== "AARAU" &&
        workspace !== "OLTEN"
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_WORKSPACE",
        });
      }

      if (
        !staff.allowedWorkspaces.includes(workspace)
      ) {
        return res.status(403).json({
          ok: false,
          error: "WORKSPACE_FORBIDDEN",
        });
      }

      const result = await db.query(`
        SELECT
          c.id,
          c.cashbox_code,
          c.driver_user_id,
          c.workspace,
          c.status,
          c.opening_float_rappen::text,
          c.issued_at,
          c.accepted_at,
          c.return_requested_at,
          c.returned_at,
          c.issued_by_user_id,
          c.closed_by_user_id,
          c.returned_float_rappen::text,
            -- ALO_NOW_V974_CASH_SHIFT_LINK
            (
              SELECT CASE
                WHEN COUNT(*) = 1 THEN MAX(sh.id::text)
                ELSE NULL
              END
              FROM alo_now_cash_custody_audit_v958 a
              JOIN alo_now_driver_cash_shifts sh
                ON sh.id = a.reference_id
              WHERE a.custody_id = c.id
                AND a.action = 'ISSUED'
                AND sh.driver_user_id = c.driver_user_id
                AND sh.workspace = c.workspace
                AND sh.opening_cash_rappen =
                    c.opening_float_rappen
            ) AS cash_shift_id,
          (
            SELECT COUNT(*)::int
            FROM alo_now_cash_envelopes_v958 e
            WHERE e.custody_id=c.id
              AND e.status='DECLARED'
          ) AS pending_envelopes
        FROM alo_now_cash_custody_v958 c
        WHERE c.workspace=$1
        ORDER BY
          CASE WHEN c.status='CLOSED' THEN 1 ELSE 0 END,
          c.issued_at DESC
        LIMIT 200
      `, [workspace]);

      for (const row of result.rows) {
        money(row.opening_float_rappen);
        if (row.returned_float_rappen !== null) {
          money(row.returned_float_rappen);
        }
      }

      return res.json({
        ok: true,
        version: "V962",
        workspace,
        currency: "CHF",
        moneyUnit: "RAPPEN",
        cashboxes: result.rows,
        readOnly: true,
      });
    } catch (error) {
      console.error("V962 ADMIN CASHBOX READ FAILED", error);
      return res.status(503).json({
        ok: false,
        error: "CASHBOX_OVERVIEW_UNAVAILABLE",
      });
    }
  }
);


// ALO_NOW_V965_ADMIN_DRIVER_HISTORY
// Read-only. No payouts and no ledger mutations.
aloNowFinanceV962Router.get(
  "/admin/driver-finance",
  async (req, res) => {
    const staff = getStaffUser(res);

    if (
      staff.role !== "ADMIN" &&
      staff.role !== "MANAGER"
    ) {
      return res.status(403).json({
        ok: false,
        error: "MANAGEMENT_ACCESS_REQUIRED",
      });
    }

    const workspace = String(
      req.query.workspace ?? ""
    ).trim().toUpperCase();

    const driverUserId = String(
      req.query.driverUserId ?? ""
    ).trim();

    if (
      (workspace !== "AARAU" &&
       workspace !== "OLTEN") ||
      !driverUserId ||
      driverUserId.length > 180
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_FINANCE_QUERY",
      });
    }

    if (!staff.allowedWorkspaces.includes(
      workspace as "AARAU" | "OLTEN"
    )) {
      return res.status(403).json({
        ok: false,
        error: "WORKSPACE_FORBIDDEN",
      });
    }

    try {
      const result = await db.query<{
        id: string;
        event_key: string;
        event_type: string;
        amount_rappen: string;
        order_id: string | null;
        cash_shift_id: string | null;
        actor_user_id: string;
        source_reference: string;
        reason: string | null;
        created_at: Date;
      }>(`
        SELECT
          id,
          event_key,
          event_type,
          amount_rappen::text,
          order_id,
          cash_shift_id,
          actor_user_id,
          source_reference,
          reason,
          created_at
        FROM alo_now_driver_finance_events
        WHERE workspace=$1
          AND driver_user_id=$2
        ORDER BY created_at DESC,id DESC
        LIMIT 100
      `, [workspace,driverUserId]);

      for (const event of result.rows) {
        const value = Number(event.amount_rappen);

        if (
          !Number.isSafeInteger(value) ||
          (
            event.event_type !== "CASH_ADJUSTMENT" &&
            value <= 0
          ) ||
          (
            event.event_type === "CASH_ADJUSTMENT" &&
            value === 0
          )
        ) {
          throw new Error("INVALID_STORED_FINANCE_EVENT");
        }
      }

      return res.json({
        ok: true,
        version: "V965",
        workspace,
        driverUserId,
        currency: "CHF",
        moneyUnit: "RAPPEN",
        financeEvents: result.rows,
        readOnly: true,
        payoutEnabled: false,
      });
    } catch (error) {
      console.error(
        "V965 ADMIN DRIVER FINANCE FAILED",
        error
      );

      return res.status(503).json({
        ok: false,
        error: "DRIVER_FINANCE_UNAVAILABLE",
      });
    }
  }
);

// ALO_NOW_V966_ATOMIC_ISSUE_ROUTE
// OFF by default and blocked in production. No actual money transfers.

// ALO_NOW_FINANCE_ELIGIBLE_DRIVERS
// Read-only, authenticated, limited to approved drivers.
aloNowFinanceV962Router.get(
  "/admin/eligible-drivers",
  async (_req, res) => {
    const staff = getStaffUser(res);

    if (
      staff.role !== "ADMIN" ||
      !staff.active ||
      !staff.approvedAt
    ) {
      return res.status(403).json({
        ok: false,
        error: "ADMIN_REQUIRED"
      });
    }

    const workspaces = (staff.allowedWorkspaces ?? [])
      .filter(w => w === "AARAU" || w === "OLTEN");

    if (workspaces.length === 0) {
      return res.json({ ok: true, users: [] });
    }

    try {
      const result = await db.query<{
        id: string;
        displayName: string;
        defaultWorkspace: string;
        jobKey: string;
        active: boolean;
      }>(`
        SELECT
          u.id::text AS id,
          COALESCE(
            NULLIF(BTRIM(u.display_name), ''),
            u.username
          ) AS "displayName",
          d.home_workspace AS "defaultWorkspace",
          'driver'::text AS "jobKey",
          TRUE AS active
        FROM staff_users u
        INNER JOIN alo_driver_profiles d
          ON d.staff_user_id = u.id
        WHERE u.active = TRUE
          AND u.approved_at IS NOT NULL
          AND (
            u.job_key = 'driver'
            OR (
              jsonb_typeof(u.job_keys) = 'array'
              AND u.job_keys ? 'driver'
            )
          )
          AND d.approved = TRUE
          AND d.home_workspace = ANY($1::text[])
          AND u.allowed_workspaces @> jsonb_build_array(d.home_workspace)
        ORDER BY "displayName" ASC
        LIMIT 200
      `, [workspaces]);

      res.setHeader("Cache-Control", "no-store");

      return res.json({
        ok: true,
        users: result.rows
      });
    } catch (error) {
      console.error(
        "ALO NOW ELIGIBLE DRIVER READ FAILED",
        error
      );

      return res.status(503).json({
        ok: false,
        error: "DRIVER_LIST_UNAVAILABLE"
      });
    }
  }
);

aloNowFinanceV962Router.post('/admin/cashboxes/issue', async (req,res)=>{
  if(process.env.ALO_NOW_CASH_ISSUE_V2175_ENABLED !== 'true'){
    return res.status(503).json({ok:false,error:'V966_STAGING_MUTATIONS_DISABLED'});
  }
  const staff=getStaffUser(res);
  if(staff.role!=='ADMIN'||!staff.active||!staff.approvedAt){
    return res.status(403).json({ok:false,error:'ADMIN_REQUIRED'});
  }
  const workspace=String(req.body?.workspace??'').trim().toUpperCase();
  const driverUserId=req.body?.driverUserId;
  const cashboxCode =
    `ALO-${workspace}-${financeCashboxUUID()}`;
  const openingFloatRappen=req.body?.openingFloatRappen;
  if((workspace!=='AARAU'&&workspace!=='OLTEN')||
    typeof driverUserId!=='string'||driverUserId.trim().length<1||driverUserId.length>180||
    typeof cashboxCode!=='string'||cashboxCode.trim().length<1||cashboxCode.length>80||
    !Number.isSafeInteger(openingFloatRappen)||openingFloatRappen<0){
    return res.status(400).json({ok:false,error:'INVALID_CASHBOX_ISSUE'});
  }
  if(!staff.allowedWorkspaces.includes(workspace as 'AARAU'|'OLTEN')){
    return res.status(403).json({ok:false,error:'WORKSPACE_OR_SELF_ISSUE_FORBIDDEN'});
  }

  try {
    // Fail closed: both active approved staff and a driver profile are required.
    const candidate=await db.query<{id:string}>(`
      SELECT u.id FROM staff_users u
      LEFT JOIN alo_driver_profiles d ON d.staff_user_id=u.id
      WHERE u.id=$1 AND u.active=TRUE AND u.approved_at IS NOT NULL
        AND (
           (
            (
              u.job_key='driver'
              OR (
                jsonb_typeof(u.job_keys)='array'
                AND u.job_keys ? 'driver'
              )
            )
            AND d.home_workspace=$2
            AND d.approved=TRUE
            AND u.allowed_workspaces @> jsonb_build_array($2::text)
          )
           OR (u.id=$3 AND u.role='ADMIN')
         )
      LIMIT 1`,[driverUserId,workspace,staff.id]);
    if(!candidate.rows[0])return res.status(409).json({ok:false,error:'DRIVER_NOT_ELIGIBLE'});
    const {issueCashboxAndOpenShiftV966}=await import('../modules/aloNow/aloNowCashboxIssue.v966.js');
    const result=await issueCashboxAndOpenShiftV966(
      {actorUserId:staff.id,workspace:workspace as 'AARAU'|'OLTEN',manager:true},
      driverUserId,cashboxCode,openingFloatRappen);
    return res.status(201).json({ok:true,version:'V966',...result});
  } catch(e){
    const code=e instanceof Error?e.message:'';
    if(code==='23505'||(typeof e==='object'&&e!==null&&'code' in e&&(e as {code?:string}).code==='23505'))
      return res.status(409).json({ok:false,error:'CASHBOX_OR_SHIFT_ALREADY_ASSIGNED'});
    console.error('V966 ISSUE FAILED',e);
    return res.status(503).json({ok:false,error:'CASHBOX_ISSUE_UNAVAILABLE'});
  }
});

// ALO_NOW_V967_CLOSE_ROUTE
// Strict staging guard. No production mutation and no driver-driven closure.
aloNowFinanceV962Router.post('/admin/cashboxes/:id/close-with-shift',async(req,res)=>{
 if(process.env.NODE_ENV==='production'||process.env.ALO_NOW_FINANCE_MUTATIONS_V967_ENABLED!=='true')
   return res.status(503).json({ok:false,error:'V967_STAGING_MUTATIONS_DISABLED'});
 const staff=getStaffUser(res);
 if(staff.role!=='ADMIN'||!staff.active||!staff.approvedAt)return res.status(403).json({ok:false,error:'ADMIN_REQUIRED'});
 const workspace=String(req.body?.workspace??'').toUpperCase();
 const custodyId=String(req.params.id??'');
 const shiftId=req.body?.shiftId;
 const countedFloatRappen=req.body?.countedFloatRappen;
 if((workspace!=='AARAU'&&workspace!=='OLTEN')||typeof shiftId!=='string'||!Number.isSafeInteger(countedFloatRappen)||countedFloatRappen<0)
   return res.status(400).json({ok:false,error:'INVALID_CLOSE_INPUT'});
 if(!staff.allowedWorkspaces.includes(workspace as 'AARAU'|'OLTEN'))return res.status(403).json({ok:false,error:'WORKSPACE_FORBIDDEN'});
 try{
  const {closeCashboxAndShiftV967}=await import('../modules/aloNow/aloNowCashboxClose.v967.js');
  const result=await closeCashboxAndShiftV967({actorUserId:staff.id,workspace:workspace as 'AARAU'|'OLTEN',manager:true},custodyId,shiftId,countedFloatRappen);
  return res.json({ok:true,version:'V967',...result});
 }catch(e){
  const code=e instanceof Error?e.message:'UNKNOWN';
  const blocked=['CUSTODY_NOT_FOUND','INDEPENDENT_COUNTER_REQUIRED','CUSTODY_RETURN_NOT_REQUESTED','SHIFT_CUSTODY_MISMATCH','SHIFT_NOT_OPEN','OPENING_FLOAT_MISMATCH','ENVELOPES_PENDING_COUNT','FINANCE_RECONCILIATION_REQUIRED','OPENING_FLOAT_DIFFERENCE_REQUIRES_MANUAL_REVIEW','CUSTODY_SHIFT_BINDING_REQUIRED','INVALID_CLOSE_INPUT'];
  if(blocked.includes(code))return res.status(409).json({ok:false,error:code});
  console.error('V967 CLOSE FAILED',e);return res.status(503).json({ok:false,error:'CASHBOX_CLOSE_UNAVAILABLE'});
 }
});


// ALO V2153: production capable only for physically counted, completely unused cashboxes.
// Explicitly disabled by default. No commission, tip, payout or cash revenue may be reconciled here.
aloNowFinanceV962Router.post('/admin/cashboxes/:id/close-empty-v2153',async(req,res)=>{
 if(process.env.ALO_NOW_EMPTY_CASH_CLOSE_V2153_ENABLED!=='true')
   return res.status(503).json({ok:false,error:'EMPTY_CASH_CLOSE_NOT_ENABLED'});
 const staff=getStaffUser(res);
 if(staff.role!=='ADMIN'||!staff.active||!staff.approvedAt)
   return res.status(403).json({ok:false,error:'ADMIN_REQUIRED'});
 const workspace=req.body?.workspace;
 const custodyId=String(req.params.id??'');
 const shiftId=req.body?.shiftId;
 const countedFloatRappen=req.body?.countedFloatRappen;
 if((workspace!=='AARAU'&&workspace!=='OLTEN')||
   !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(custodyId)||
   typeof shiftId!=='string'||
   !Number.isSafeInteger(countedFloatRappen)||countedFloatRappen<0)
   return res.status(400).json({ok:false,error:'INVALID_CLOSE_INPUT'});
 if(!staff.allowedWorkspaces.includes(workspace))
   return res.status(403).json({ok:false,error:'WORKSPACE_FORBIDDEN'});
 try{
   const {closeCashboxAndShiftV967}=await import('../modules/aloNow/aloNowCashboxClose.v967.js');
   const result=await closeCashboxAndShiftV967(
     {actorUserId:staff.id,workspace,manager:true},custodyId,shiftId,countedFloatRappen,true);
   return res.json({ok:true,version:'V2153',...result});
 }catch(e){
   const code=e instanceof Error?e.message:'UNKNOWN';
   const blocked=['CUSTODY_NOT_FOUND','INDEPENDENT_COUNTER_REQUIRED','CUSTODY_RETURN_NOT_REQUESTED',
     'SHIFT_CUSTODY_MISMATCH','SHIFT_NOT_OPEN','OPENING_FLOAT_MISMATCH','ENVELOPES_PENDING_COUNT',
     'FINANCE_RECONCILIATION_REQUIRED','OPENING_FLOAT_DIFFERENCE_REQUIRES_MANUAL_REVIEW',
     'CUSTODY_SHIFT_BINDING_REQUIRED','INVALID_CLOSE_INPUT','INVALID_DRIVER_ID',
     'EMPTY_CASHBOX_HAS_DELIVERIES','EMPTY_CASHBOX_HAS_FINANCE_EVENTS','EMPTY_CASHBOX_HAS_ENVELOPES'];
   if(blocked.includes(code))return res.status(409).json({ok:false,error:code});
   console.error('V2153 EMPTY CLOSE FAILED',e);
   return res.status(503).json({ok:false,error:'EMPTY_CASHBOX_CLOSE_UNAVAILABLE'});
 }
});

// ALO_V2104_ADMIN_RETURN_REQUEST: OFF by default; independent physical counting still required.
aloNowFinanceV962Router.post('/admin/cashboxes/:id/request-return-v2104',async(req,res)=>{
  if(process.env.ALO_NOW_ADMIN_CASH_RETURN_V2104_ENABLED!=='true')
    return res.status(503).json({ok:false,error:'ADMIN_CASH_RETURN_NOT_ENABLED'});
  const staff=getStaffUser(res);
  if(staff.role!=='ADMIN'||!staff.active||!staff.approvedAt)
    return res.status(403).json({ok:false,error:'ADMIN_REQUIRED'});
  const workspace=req.body?.workspace;
  if(workspace!=='AARAU'&&workspace!=='OLTEN')
    return res.status(400).json({ok:false,error:'INVALID_WORKSPACE'});
  if(!staff.allowedWorkspaces.includes(workspace))
    return res.status(403).json({ok:false,error:'WORKSPACE_FORBIDDEN'});
  const custodyId=String(req.params.id??'');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(custodyId))
    return res.status(400).json({ok:false,error:'INVALID_CUSTODY_ID'});
  try{
    const result=await requestCashboxReturnByAdminV2104(
      {actorUserId:staff.id,workspace,manager:true},custodyId);
    return res.json({ok:true,version:'V2104',...result});
  }catch(err){
    const code=err instanceof Error?err.message:'UNKNOWN';
    if(['CUSTODY_NOT_FOUND','CUSTODY_NOT_ACTIVE','CUSTODY_UPDATE_CONFLICT'].includes(code))
      return res.status(409).json({ok:false,error:code});
    if(code==='INDEPENDENT_ADMIN_REQUIRED'||code==='WORKSPACE_FORBIDDEN')
      return res.status(403).json({ok:false,error:code});
    console.error('V2104_ADMIN_RETURN_FAILED',code);
    return res.status(503).json({ok:false,error:'ADMIN_RETURN_UNAVAILABLE'});
  }
});

// ALO V2128B: Read-only production routes recovered.


// ALO V2161: Authenticated, read-only confirmed payout history.
// A verified available balance is NOT established here.
aloNowFinanceV962Router.get(
  '/admin/driver-payouts-v2090',
  async (req, res) => {
    const staff = getStaffUser(res);

    if (
      !staff.active ||
      !staff.approvedAt ||
      (staff.role !== 'ADMIN' && staff.role !== 'MANAGER')
    ) {
      return res.status(403).json({
        ok: false,
        error: 'MANAGEMENT_ACCESS_REQUIRED'
      });
    }

    const workspace = String(
      req.query.workspace ?? ''
    ).trim().toUpperCase();

    const driverUserId = String(
      req.query.driverUserId ?? ''
    ).trim();

    if (
      (workspace !== 'AARAU' && workspace !== 'OLTEN') ||
      !/^[1-9][0-9]{0,18}$/.test(driverUserId)
    ) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_PAYOUT_QUERY'
      });
    }

    if (!staff.allowedWorkspaces.includes(
      workspace as 'AARAU' | 'OLTEN'
    )) {
      return res.status(403).json({
        ok: false,
        error: 'WORKSPACE_FORBIDDEN'
      });
    }

    try {
      const result = await db.query<{
        id: string;
        amount_rappen: string;
        payment_reference: string;
        confirmed_at: Date;
      }>(`
        SELECT id,
               amount_rappen::text,
               payment_reference,
               confirmed_at
        FROM alo_now_driver_confirmed_payouts_v2089
        WHERE workspace=$1
          AND driver_user_id=$2
        ORDER BY confirmed_at DESC,id DESC
        LIMIT 100
      `, [workspace, driverUserId]);

      const payoutHistory = result.rows.map(row => ({
        id: row.id,
        amountRappen: money(row.amount_rappen),
        paymentReference: row.payment_reference,
        confirmedAt: new Date(
          row.confirmed_at
        ).toISOString()
      }));

      return res.json({
        ok: true,
        version: 'V2161',
        workspace,
        driverUserId,
        currency: 'CHF',
        moneyUnit: 'RAPPEN',
        payoutOutstandingRappen: null,
        settlementStatus:
          'PENDING_VERIFIED_RECONCILIATION',
        payoutEnabled: false,
        readOnly: true,
        payoutHistory
      });
    } catch (error) {
      console.error(
        'V2161 PAYOUT ACCOUNT READ FAILED',
        error
      );

      return res.status(503).json({
        ok: false,
        error: 'PAYOUT_ACCOUNT_UNAVAILABLE'
      });
    }
  }
);

aloNowFinanceV962Router.get('/admin/driver-accounts', async (req, res) => {
    const staff = getStaffUser(res);
    if (staff.role !== 'ADMIN' && staff.role !== 'MANAGER') {
        return res.status(403).json({ ok: false, error: 'MANAGEMENT_ACCESS_REQUIRED' });
    }
    const workspace = String(req.query.workspace ?? '').trim().toUpperCase();
    if (workspace !== 'AARAU' && workspace !== 'OLTEN') {
        return res.status(400).json({ ok: false, error: 'INVALID_WORKSPACE' });
    }
    if (!staff.allowedWorkspaces.includes(workspace)) {
        return res.status(403).json({ ok: false, error: 'WORKSPACE_FORBIDDEN' });
    }
    try {
        const result = await db.query(`
      SELECT u.id::text AS driver_user_id,
        COALESCE(NULLIF(BTRIM(u.display_name), ''), NULLIF(BTRIM(u.username), ''), 'Fahrer') AS driver_name,
        custody.cashbox_code, custody.status AS cashbox_status,
        custody.opening_float_rappen::text,
        (SELECT COUNT(*)::int FROM alo_now_driver_finance_events e
         WHERE e.driver_user_id=u.id::text AND e.workspace=$1) AS finance_event_count,
        (SELECT COUNT(*)::int FROM alo_now_deliveries d
         WHERE d.assigned_driver_user_id=u.id AND d.fulfillment_workspace=$1
           AND d.delivery_status='DELIVERED' AND d.delivered_at IS NOT NULL
           AND d.cancelled_at IS NULL) AS confirmed_delivery_count
      FROM staff_users u
      LEFT JOIN alo_driver_profiles p ON p.staff_user_id=u.id
      LEFT JOIN LATERAL (
         SELECT c.cashbox_code,c.status,c.opening_float_rappen
         FROM alo_now_cash_custody_v958 c
         WHERE c.driver_user_id=u.id::text AND c.workspace=$1 AND c.status <> 'CLOSED'
         ORDER BY c.issued_at DESC LIMIT 1
      ) custody ON TRUE
      WHERE u.active=TRUE AND u.approved_at IS NOT NULL
        AND (p.staff_user_id IS NOT NULL
             OR (u.id=$2 AND u.role='ADMIN'))
      ORDER BY CASE WHEN custody.status IS NULL THEN 1 ELSE 0 END,
               LOWER(COALESCE(u.display_name,u.username,'Fahrer')),u.id
      LIMIT 200
    `, [workspace, staff.id]);
        const drivers = result.rows.map(row => ({
            driverUserId: row.driver_user_id,
            driverName: row.driver_name,
            currentWorkspace: workspace,
            cashbox: row.cashbox_status === null ? null : {
                code: row.cashbox_code, status: row.cashbox_status,
                openingFloatRappen: row.opening_float_rappen === null ? null : money(row.opening_float_rappen),
            },
            confirmedDeliveryCount: row.confirmed_delivery_count,
            financeEventCount: row.finance_event_count,
            cashHandoverOutstandingRappen: null,
            cardPayableOutstandingRappen: null,
            settlementStatus: 'PENDING_VERIFIED_RECONCILIATION',
        }));
        return res.json({
            ok: true, version: 'V1917', workspace, currency: 'CHF', moneyUnit: 'RAPPEN',
            drivers, cashHandoverOutstandingRappen: null,
            cardPayableOutstandingRappen: null,
            payoutEnabled: false, readOnly: true,
        });
    }
    catch (error) {
        console.error('V1917 DRIVER ACCOUNTS READ FAILED', error);
        return res.status(503).json({ ok: false, error: 'DRIVER_ACCOUNTS_UNAVAILABLE' });
    }
});

aloNowFinanceV962Router.get('/admin/driver-trips', async (req, res) => {
    const staff = getStaffUser(res);
    if (staff.role !== 'ADMIN' && staff.role !== 'MANAGER')
        return res.status(403).json({ ok: false, error: 'MANAGEMENT_ACCESS_REQUIRED' });
    const workspace = String(req.query.workspace ?? '').trim().toUpperCase();
    const driverUserId = String(req.query.driverUserId ?? '').trim();
    if ((workspace !== 'AARAU' && workspace !== 'OLTEN') || !/^\d+$/.test(driverUserId))
        return res.status(400).json({ ok: false, error: 'INVALID_DRIVER_TRIPS_QUERY' });
    if (!staff.allowedWorkspaces.includes(workspace))
        return res.status(403).json({ ok: false, error: 'WORKSPACE_FORBIDDEN' });
    try {
        const result = await db.query(`SELECT shopify_order_id, shopify_order_name, delivered_at,
              fulfillment_workspace
         FROM alo_now_deliveries
        WHERE assigned_driver_user_id=$1
          AND fulfillment_workspace=$2
          AND delivery_status='DELIVERED'
          AND delivered_at IS NOT NULL AND cancelled_at IS NULL
        ORDER BY delivered_at DESC, id DESC
        LIMIT 50`, [driverUserId, workspace]);
        return res.json({ ok: true, version: 'V2039', driverUserId, workspace,
            timezone: 'Europe/Zurich', trips: result.rows, readOnly: true,
            moneyVerified: false, payoutEnabled: false });
    }
    catch (error) {
        console.error('V2039 DRIVER TRIPS READ FAILED', error);
        return res.status(503).json({ ok: false, error: 'DRIVER_TRIPS_UNAVAILABLE' });
    }
});

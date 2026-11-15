
import test from "node:test";
import assert from "node:assert/strict";
import {
  readDriverWalletCandidatesV1678
} from "./aloNowWalletReader.v1678.js";

const valid = {
  order_id:"ORDER-1",
  delivery_status:"DELIVERED",
  delivered_at:"2026-11-04T12:00:00Z",
  cancelled_at:null,
  assigned_driver_user_id:"101",
  payment_count:"1",
  payment_phase:"CONFIRMED",
  payment_method:"CARD",
  handoff_count:"1",
  handoff_state:"COMPLETED",
  settlement_state:"FINAL",
  finance_event_count:"2",
  invalid_finance_event_count:"0",
  reconciliation_count:"0"
};

test("leere Datenbank liefert keine erfundenen Ansprüche",async()=>{
  const result=await readDriverWalletCandidatesV1678(
    async()=>({rows:[]}),"101","AARAU"
  );
  assert.deepEqual(result,[]);
});

test("SQL ist auf Fahrer und Standort eingeschränkt",async()=>{
  let checked=false;
  await readDriverWalletCandidatesV1678(
    async(sql,params)=>{
      assert.match(sql,/assigned_driver_user_id::text=\$1/);
      assert.match(sql,/fulfillment_workspace=\$2/);
      assert.deepEqual(params,["101","AARAU"]);
      checked=true;
      return {rows:[]};
    },
    "101","AARAU"
  );
  assert.equal(checked,true);
});

test("keine Auszahlung ohne externe Verifikation",async()=>{
  const result=await readDriverWalletCandidatesV1678(
    async()=>({rows:[{...valid}]}),
    "101","AARAU"
  );
  assert.equal(result[0].payoutEnabled,false);
  assert.equal(result[0].payableOutstandingRappen,null);
  assert.ok(result[0].blockers.includes(
    "TRUSTED_PROVIDER_AND_AMOUNT_CHECK_PENDING"
  ));
});

test("fehlende Zahlungszuordnung wird erkannt",async()=>{
  const result=await readDriverWalletCandidatesV1678(
    async()=>({rows:[{...valid,payment_count:"0"}]}),
    "101","AARAU"
  );
  assert.ok(result[0].blockers.includes(
    "PAYMENT_BINDING_NOT_UNIQUE"
  ));
});

test("offener Zahlungsabgleich blockiert",async()=>{
  const result=await readDriverWalletCandidatesV1678(
    async()=>({rows:[{...valid,reconciliation_count:"1"}]}),
    "101","AARAU"
  );
  assert.ok(result[0].blockers.includes(
    "PAYMENT_RECONCILIATION_OPEN"
  ));
});

test("fremder Fahrer wird abgelehnt",async()=>{
  await assert.rejects(
    readDriverWalletCandidatesV1678(
      async()=>({rows:[{
        ...valid,assigned_driver_user_id:"999"
      }]}),
      "101","AARAU"
    ),
    /WALLET_DB_IDENTITY_MISMATCH/
  );
});

test("nicht gelieferte Bestellung wird gesperrt",async()=>{
  const result=await readDriverWalletCandidatesV1678(
    async()=>({rows:[{
      ...valid,delivery_status:"ON_THE_WAY"
    }]}),
    "101","AARAU"
  );
  assert.ok(result[0].blockers.includes(
    "DELIVERY_NOT_FINAL"
  ));
});

test("ungültige Fahrer-ID wird abgelehnt",async()=>{
  await assert.rejects(
    readDriverWalletCandidatesV1678(
      async()=>({rows:[]}),"x","AARAU"
    ),
    /INVALID_WALLET_SCOPE/
  );
});

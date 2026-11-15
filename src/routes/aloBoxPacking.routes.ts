// ALO_V1238_PERSISTENT_BOX_PACKING
import {Router} from "express";
import {db} from "../database/db.js";
import {
  getStaffUser,requireStaffAuth
} from "../middleware/staffAuth.js";
import {hasStaffCapability} from "../middleware/staffRbac.js";

const router=Router();
router.use("/api/alo-box/packing",requireStaffAuth);

let schemaPromise:Promise<void>|null=null;

function ensureSchema(){
  if(!schemaPromise){
    schemaPromise=db.query(`
      CREATE TABLE IF NOT EXISTS alo_box_packing (
        order_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1
          CHECK(version>0),
        contents JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).then(()=>undefined).catch(error=>{
      schemaPromise=null;
      throw error;
    });
  }
  return schemaPromise;
}

function permitted(
  res:any,
  capability:"orders.view"|"orders.pack"
){
  const staff=getStaffUser(res);
  return staff.allowedWorkspaces.includes("ONLINE") &&
    (
      staff.role==="ADMIN" ||
      hasStaffCapability(staff,capability)
    );
}

function validOrderId(value:unknown):value is string{
  return typeof value==="string" &&
    value.length>0 &&
    value.length<=180 &&
    /^[A-Za-z0-9_:\-/]+$/.test(value);
}

type Item={
  productId:string;
  title:string;
  unitPriceCents:number;
  quantity:number;
};

function validateContents(input:unknown):
  Record<string,Item[]>|null {
  if(
    !input || typeof input!=="object" ||
    Array.isArray(input)
  )return null;

  const entries=Object.entries(input);
  if(entries.length>100)return null;

  const result:Record<string,Item[]>={};

  for(const [boxId,rawItems] of entries){
    if(
      !boxId || boxId.length>250 ||
      !Array.isArray(rawItems) ||
      rawItems.length>150
    )return null;

    const seen=new Set<string>();
    const items:Item[]=[];

    for(const raw of rawItems){
      if(!raw||typeof raw!=="object"||
        Array.isArray(raw))return null;

      const value=raw as Record<string,unknown>;
      const productId=value.productId;
      const title=value.title;
      const unitPriceCents=value.unitPriceCents;
      const quantity=value.quantity;

      if(
        typeof productId!=="string" ||
        !/^[0-9]{1,20}$/.test(productId) ||
        seen.has(productId) ||
        typeof title!=="string" ||
        !title.trim() ||
        title.length>300 ||
        !Number.isSafeInteger(unitPriceCents) ||
        (unitPriceCents as number)<=0 ||
        (unitPriceCents as number)>1000000 ||
        !Number.isSafeInteger(quantity) ||
        (quantity as number)<=0 ||
        (quantity as number)>1000
      )return null;

      seen.add(productId);
      items.push({
        productId,title,
        unitPriceCents:unitPriceCents as number,
        quantity:quantity as number
      });
    }
    result[boxId]=items;
  }

  return result;
}

router.get("/api/alo-box/packing/:orderId",
  async(req,res)=>{
    try{
      if(!permitted(res,"orders.view")){
        res.status(403).json({
          ok:false,error:"Keine Packberechtigung."
        });
        return;
      }

      const orderId=String(req.params.orderId??"");
      if(!validOrderId(orderId)){
        res.status(400).json({
          ok:false,error:"Ungültige Bestell-ID."
        });
        return;
      }

      await ensureSchema();
      const result=await db.query(
        `SELECT order_id,version,contents,
                updated_by,updated_at
         FROM alo_box_packing
         WHERE order_id=$1`,
        [orderId]
      );

      const row=result.rows[0];

      res.json({
        ok:true,
        version:row?.version??0,
        contents:row?.contents??{},
        updatedBy:row?.updated_by??null,
        updatedAt:row?.updated_at??null
      });

    }catch(error){
      console.error("ALO BOX load failed",error);
      res.status(500).json({
        ok:false,error:"Packliste konnte nicht geladen werden."
      });
    }
  }
);

router.put("/api/alo-box/packing/:orderId",
  async(req,res)=>{
    try{
      if(!permitted(res,"orders.pack")){
        res.status(403).json({
          ok:false,error:"Keine Packberechtigung."
        });
        return;
      }

      const orderId=String(req.params.orderId??"");
      const version=req.body?.version;
      const contents=validateContents(req.body?.contents);

      if(
        !validOrderId(orderId) ||
        !Number.isSafeInteger(version) ||
        version<0 || version>2147483646 ||
        contents===null
      ){
        res.status(400).json({
          ok:false,error:"Ungültige Packdaten oder Version."
        });
        return;
      }

      const staff=getStaffUser(res);
      await ensureSchema();

      const result=version===0
        ? await db.query(
            `INSERT INTO alo_box_packing
              (order_id,version,contents,updated_by,updated_at)
             VALUES ($1,1,$2::jsonb,$3,NOW())
             ON CONFLICT (order_id) DO NOTHING
             RETURNING version,updated_at`,
            [orderId,JSON.stringify(contents),staff.id]
          )
        : await db.query(
            `UPDATE alo_box_packing
             SET version=version+1,
                 contents=$3::jsonb,
                 updated_by=$4,
                 updated_at=NOW()
             WHERE order_id=$1 AND version=$2
             RETURNING version,updated_at`,
            [
              orderId,version,
              JSON.stringify(contents),staff.id
            ]
          );

      if(!result.rowCount){
        res.status(409).json({
          ok:false,
          code:"PACK_VERSION_CONFLICT",
          error:"Packliste wurde inzwischen verändert. "+
            "Bitte neu laden, bevor du weiterarbeitest."
        });
        return;
      }

      res.json({
        ok:true,
        version:result.rows[0].version,
        updatedAt:result.rows[0].updated_at
      });

    }catch(error){
      // Zwei gleichzeitige Erst-Speicherungen:
      // Der eindeutige Bestellschlüssel darf nie überschrieben werden.
      if(
        (error as {code?:string})?.code==="23505"
      ){
        res.status(409).json({
          ok:false,
          code:"PACK_VERSION_CONFLICT",
          error:"Packliste wurde inzwischen erstellt. "+
            "Bitte neu laden."
        });
        return;
      }

      console.error("ALO BOX save failed",error);
      res.status(500).json({
        ok:false,error:"Packliste konnte nicht gespeichert werden."
      });
    }
  }
);

export default router;

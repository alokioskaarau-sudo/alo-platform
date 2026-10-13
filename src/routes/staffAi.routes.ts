import { Router } from "express";
import OpenAI from "openai";
import multer from "multer";
import { toFile } from "openai";
import { requireStaffAuth, getStaffUser } from "../middleware/staffAuth.js";
import { db } from "../database/db.js";
import { effectiveStaffCapabilities } from "../middleware/staffRbac.js";

const router = Router();
router.use(requireStaffAuth);


// ALO_AI_PRODUCT_TOOL_V1
// ALO_AI_PRODUCT_TOOL_V45
async function searchAloProducts(query: string, allowedWorkspaces: string[]) {
  const normalized = query.trim().toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().slice(0, 100);
  const terms = normalized.split(/\s+/).filter(Boolean).slice(0, 6);
  if (!terms.length) return [];
  const locations = [...new Set(allowedWorkspaces.map(x => x.toLowerCase())
    .filter(x => ["aarau", "olten", "online"].includes(x)))];
  const searchable = `LOWER(CONCAT_WS(' ', p.title, p.brand, p.barcode,
    p.product_name, p.category, p.subcategory, p.unit_size))`;
  const compact = `REGEXP_REPLACE(${searchable}, '[^a-z0-9]+', '', 'g')`;
  const params: unknown[] = terms.map(t => `%${t}%`);
  const tokenFilter = terms.map((_, i) => `${searchable} LIKE $${i + 1}`).join(' AND ');
  const compactQuery = normalized.replace(/[^a-z0-9]+/g, '');
  params.push(`%${compactQuery}%`);
  const compactIndex = params.length;
  params.push(normalized);
  const exactIndex = params.length;
  params.push(`${normalized}%`);
  const prefixIndex = params.length;
  params.push(locations);
  const locationsIndex = params.length;
  const result = await db.query(`
    WITH matched AS (
      SELECT p.id, p.title, p.barcode, p.brand, p.unit_size,
        p.category, p.country, p.ingredients, p.allergens,
          EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = p.id) AS has_image
      FROM products p
      WHERE (${tokenFilter}) OR ${compact} LIKE $${compactIndex}
      ORDER BY CASE
        WHEN LOWER(COALESCE(p.barcode, '')) = $${exactIndex} THEN 0
        WHEN LOWER(COALESCE(p.title, '')) = $${exactIndex} THEN 1
        WHEN LOWER(COALESCE(p.title, '')) LIKE $${prefixIndex} THEN 2
        ELSE 3 END, p.title, p.id
      LIMIT 10
    )
    SELECT m.*, s.store_id, s.exact_quantity, s.updated_at AS stock_updated_at
    FROM matched m
    LEFT JOIN product_stock_snapshots s ON s.product_id = m.id
      AND s.store_id = ANY($${locationsIndex}::text[])
    ORDER BY m.title, m.id, s.store_id
  `, params);
  const products = new Map<string, any>();
  for (const row of result.rows) {
    const key = String(row.id);
    if (!products.has(key)) {
      products.set(key, {
        id: row.id, title: row.title, barcode: row.barcode,
        brand: row.brand, unitSize: row.unit_size,
        category: row.category, country: row.country,
        ingredients: row.ingredients, allergens: row.allergens,
          hasImage: Boolean(row.has_image),
        stock: Object.fromEntries(locations.map(loc => [loc, null]))
      });
    }
    if (row.store_id && locations.includes(row.store_id)) {
      products.get(key).stock[row.store_id] = {
        quantity: row.exact_quantity ?? null,
        updatedAt: row.stock_updated_at,
        source: "ALO_CORE_SNAPSHOT"
      };
    }
  }
  return Array.from(products.values());
}


// ALO_216_SCHEDULE_AI_PREVIEW: read-only proposal; NEVER writes schedule data.
type SchedulePreview = {
  staffUserId: number;
  employeeName: string;
  workspace: "AARAU" | "OLTEN";
  startsAt: string;
  endsAt: string;
  shiftPreset: "EARLY" | "LATE" | "FULL" | "CUSTOM";
  conflicts: Array<{ type: "SHIFT" | "ABSENCE"; description: string }>;
  confirmationRequired: true;
  status: "PREVIEW_ONLY_NOT_SAVED";
};

async function prepareAloSchedulePreview(args: any): Promise<SchedulePreview> {
  const staffUserId = Number(args.staffUserId);
  const startsAt = new Date(args.startsAt);
  const endsAt = new Date(args.endsAt);
  const workspace = String(args.workspace || "");
  const shiftPreset = String(args.shiftPreset || "CUSTOM");
  if (!Number.isSafeInteger(staffUserId) || staffUserId <= 0 ||
      !["AARAU", "OLTEN"].includes(workspace) ||
      !["EARLY", "LATE", "FULL", "CUSTOM"].includes(shiftPreset) ||
      typeof args.startsAt !== "string" || typeof args.endsAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(args.startsAt) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(args.endsAt) ||
      !Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) ||
      startsAt >= endsAt || endsAt.getTime() - startsAt.getTime() > 24*60*60*1000 ||
      startsAt.getTime() < Date.now() - 60*1000 ||
      startsAt.getTime() > Date.now() + 180*24*60*60*1000) {
    throw new Error("Ungültige Schichtangaben. Bitte Person, Standort und genaue zukünftige Start-/Endzeit angeben.");
  }
  const employee = await db.query(
    `SELECT id, display_name AS "displayName" FROM staff_users
     WHERE id=$1 AND active=TRUE AND approved_at IS NOT NULL LIMIT 1`,
    [staffUserId]
  );
  if (!employee.rows.length) throw new Error("Aktiver Mitarbeiter nicht gefunden.");
  const clashes = await db.query(
    `SELECT workspace, starts_at, ends_at, status
     FROM staff_schedule_shifts
     WHERE staff_user_id=$1 AND status <> 'CANCELLED'
       AND starts_at < $3 AND ends_at > $2
     ORDER BY starts_at LIMIT 10`,
    [staffUserId, startsAt, endsAt]
  );
  const absences = await db.query(
    `SELECT request_type, starts_at, ends_at FROM staff_schedule_requests
     WHERE staff_user_id=$1 AND status='APPROVED'
       AND starts_at < $3 AND ends_at > $2 LIMIT 10`,
    [staffUserId, startsAt, endsAt]
  );
  return {
    staffUserId, employeeName: String(employee.rows[0].displayName),
    workspace: workspace as "AARAU" | "OLTEN",
    startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
    shiftPreset: shiftPreset as SchedulePreview["shiftPreset"],
    conflicts: [
      ...clashes.rows.map((c:any) => ({type:"SHIFT" as const, description:
        `${c.workspace}: ${new Date(c.starts_at).toISOString()} – ${new Date(c.ends_at).toISOString()} (${c.status})`})),
      ...absences.rows.map((a:any) => ({type:"ABSENCE" as const, description:
        `${a.request_type}: ${new Date(a.starts_at).toISOString()} – ${new Date(a.ends_at).toISOString()}`}))
    ],
    confirmationRequired: true,
    status: "PREVIEW_ONLY_NOT_SAVED"
  };
}

// ALO_STAFF_AI_V40
router.post("/chat", async (req, res) => {
  const messages = req.body?.messages;

  if (!Array.isArray(messages) || messages.length < 1 ||
      messages.length > 20 ||
      messages.some((m: any) =>
        !m || !["user", "assistant"].includes(m.role) ||
        typeof m.content !== "string" ||
        !m.content.trim() || m.content.length > 3000
      ) ||
      messages[messages.length - 1].role !== "user") {
    res.status(422).json({
      ok: false, error: "Ungültiger Chatverlauf."
    });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    res.status(503).json({
      ok: false, error: "Frag ALO ist nicht konfiguriert."
    });
    return;
  }

  try {
    const ai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 30000,
      maxRetries: 1
    });

    const tools: any[] = [{
      type: "function",
      name: "search_alo_products",
      description: "Sucht ALO CORE Produkte und Bestände nach Produktname, Marke oder Barcode.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" }
        },
        required: ["query"],
        additionalProperties: false
      },
      strict: true
    }, {
      type: "function",
      name: "prepare_inventory_adjustment_request",
      description: "Bereitet NUR eine Online-Bestandskorrektur zur ausdruecklichen Bestaetigung vor. Speichert keinen Antrag und aendert keinen Bestand. Nur bei eindeutigem Produkt und vom Mitarbeiter genannter Zielmenge verwenden.",
      parameters: {
        type: "object",
        properties: {
          productId: { type: "integer", description: "Eindeutige ALO CORE Produkt-ID aus search_alo_products" },
          quantity: { type: "integer", description: "Vom Mitarbeiter genannte neue absolute Online-Stueckzahl" },
          reason: { type: "string", description: "Begruendung des Mitarbeiters, mindestens 5 Zeichen" }
        },
        required: ["productId", "quantity", "reason"],
        additionalProperties: false
      },
      strict: true
    }, {
      type: "function",
      name: "search_schedule_employees",
      description: "Sucht aktive ALO Mitarbeitende nach Namen, damit Schichtvorschläge der richtigen Person zugeordnet werden. Nur fuer Admins mit schedule.manage.",
      parameters: {type:"object", properties:{query:{type:"string"}}, required:["query"], additionalProperties:false},
      strict: true
    }, {
      type: "function",
      name: "prepare_schedule_shift_preview",
      description: "Prueft einen neuen Dienst und erstellt NUR eine unverbindliche Vorschau. KEINE Speicherung, KEINE Veroeffentlichung. Erst employee ID suchen, genaue ISO-8601-Zeit inklusive Offset und Standort ermitteln. Nur fuer Planungsberechtigte.",
      parameters: {type:"object", properties:{
        staffUserId:{type:"integer"}, workspace:{type:"string",enum:["AARAU","OLTEN"]},
        startsAt:{type:"string"}, endsAt:{type:"string"},
        shiftPreset:{type:"string",enum:["EARLY","LATE","FULL","CUSTOM"]}
      }, required:["staffUserId","workspace","startsAt","endsAt","shiftPreset"],additionalProperties:false},
      strict: true
    }];

    // ALO_STRUCTURED_APPROVAL_PREVIEW_V1
    let schedulePreview: SchedulePreview | null = null;
    // ALO_227_PRODUCT_CARDS: source-backed display data, never model-generated.
    let productCards: any[] = [];
    let approvalPreview: null | { productId: number; productTitle: string; workspace: "ONLINE"; quantity: number; reason: string; confirmationRequired: true; status: "PREVIEW_ONLY_NOT_SUBMITTED" } = null;

    const input: any[] = messages.map((m: any) => ({
      role: m.role,
      content: m.content.trim()
    }));

    let response = await ai.responses.create({
      model: process.env.ALO_STAFF_AI_MODEL || "gpt-5-mini",
      max_output_tokens: 2400,
      instructions:
        "Du bist Frag ALO, der interne Assistent von ALO Kiosk. " +
        "Antworte auf Deutsch mit Schweizer Rechtschreibung. " +
        "Hilf bei Kiosk-Alltag, Kundenservice und Produktfragen. " +
        "Erfinde keine internen Regeln, Preise oder Bestände. " +
        "Du darfst Produktinformationen ausschliesslich aus dem bereitgestellten Werkzeug verwenden. " +
        "Sprich wie ein freundlicher, schneller Kollege. Antworte bei Produktfragen kurz und natürlich. " +
        "Nenne keine IDs, Artikelnummern oder Barcodes, ausser ausdrücklich danach gefragt. " +
        "Die Benutzeroberfläche zeigt Produktkarten und Bestände getrennt an; lies nicht alle Metadaten vor. " +
        "Erfinde niemals Bestände oder Preise. " +
        "Online-Bestände aus Snapshots sind möglicherweise nicht live. " +
        "Bei Bestandskorrekturen erst das Produkt suchen und dann nur eine Vorschau mit prepare_inventory_adjustment_request erstellen. " +
        "Niemals behaupten, ein Antrag sei eingereicht oder Bestand geaendert. Eine Bestaetigung im Chat allein fuehrt keine Aktion aus. " +
        "Bei Dienstplanfragen suche zuerst mit search_schedule_employees die eindeutige Mitarbeiter-ID. " +
        "Das heutige Datum ist " + new Date().toLocaleDateString("de-CH", {timeZone:"Europe/Zurich"}) + ". " +
        "Fuer Schichtvorschlaege nutze prepare_schedule_shift_preview, mit ISO-8601 Uhrzeiten samt Schweizer Zeitzonen-Offset. " +
        "Schichten werden NIE im Chat gespeichert oder veroeffentlicht. Fehlende Angaben erfragen, Konflikte nennen.",
      tools,
      input
    });

    for (let round = 0; round < 5; round++) {
      const calls = response.output.filter(
        (item: any) => item.type === "function_call"
      ) as any[];

      if (!calls.length) break;

      input.push(...response.output);

      for (const call of calls) {
        if (call.name === "search_schedule_employees" || call.name === "prepare_schedule_shift_preview") {
          const actor = getStaffUser(res);
          let result: any;
          if (!effectiveStaffCapabilities(actor).has("schedule.manage")) {
            result = {ok:false,error:"Keine Berechtigung zur Schichtplanung."};
          } else {
            try {
              const args = JSON.parse(call.arguments || "{}");
              if (call.name === "search_schedule_employees") {
                const query = String(args.query || "").trim().slice(0,80);
                if (query.length < 2) {
                  result = {ok:false,error:"Bitte mindestens 2 Zeichen des Namens nennen."};
                } else {
                  const rows = await db.query(
                    `SELECT id, display_name AS "displayName", default_workspace AS "defaultWorkspace"
                     FROM staff_users WHERE active=TRUE AND approved_at IS NOT NULL
                     AND display_name ILIKE $1 ORDER BY display_name LIMIT 15`,
                    [`%${query}%`]
                  );
                  result = {ok:true,employees:rows.rows};
                }
              } else {
                schedulePreview = await prepareAloSchedulePreview(args);
                result = {ok:true,...schedulePreview,message:"Nur Vorschau. Kein Dienst gespeichert oder veroeffentlicht."};
              }
            } catch (error:any) {
              result = {ok:false,error:String(error?.message || "Vorschau konnte nicht geprueft werden.")};
            }
          }
          input.push({type:"function_call_output",call_id:call.call_id,output:JSON.stringify(result)});
          continue;
        }
        if (call.name === "prepare_inventory_adjustment_request") {
          const args = JSON.parse(call.arguments || "{}");
          const staff = getStaffUser(res);
          let result: any = { ok: false, error: "Antrag kann nicht vorbereitet werden." };
          if (!staff.allowedWorkspaces.includes("ONLINE")) {
            result = { ok: false, error: "Kein Zugriff auf ONLINE." };
          } else if (!Number.isSafeInteger(args.productId) || args.productId <= 0 ||
                     !Number.isSafeInteger(args.quantity) || args.quantity < 0 ||
                     typeof args.reason !== "string" || args.reason.trim().length < 5 ||
                     args.reason.trim().length > 1000) {
            result = { ok: false, error: "Ungueltige Produkt-ID, Menge oder Begruendung." };
          } else {
            const found = await db.query(
              "SELECT id, title, shopify_inventory_item_id FROM products WHERE id = $1 LIMIT 1",
              [args.productId]
            );
            const product = found.rows[0];
            if (!product) {
              result = { ok: false, error: "Produkt nicht gefunden." };
            } else if (!product.shopify_inventory_item_id) {
              result = { ok: false, error: "Keine Shopify-Lagerverknuepfung." };
            } else {
              result = {
                ok: true, status: "PREVIEW_ONLY_NOT_SUBMITTED",
                productId: product.id, productTitle: product.title,
                workspace: "ONLINE", quantity: args.quantity,
                reason: args.reason.trim(),
                confirmationRequired: true,
                message: "Nur Vorschau. Es wurde kein Antrag erstellt und kein Bestand geaendert."
              };
            }
          }
          if (result.ok === true && result.status === "PREVIEW_ONLY_NOT_SUBMITTED") {
            approvalPreview = {
              productId: Number(result.productId),
              productTitle: String(result.productTitle),
              workspace: "ONLINE",
              quantity: result.quantity,
              reason: result.reason,
              confirmationRequired: true,
              status: "PREVIEW_ONLY_NOT_SUBMITTED"
            };
          }
          input.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(result)
          });
          continue;
        }
        if (call.name !== "search_alo_products") {
          throw new Error("Unbekanntes KI-Werkzeug.");
        }

        const args = JSON.parse(call.arguments || "{}");
        const products = await searchAloProducts(
          String(args.query || ""),
          getStaffUser(res).allowedWorkspaces
        );
        productCards = products.slice(0, 16).map((p: any) => ({
          id: p.id, title: p.title, brand: p.brand, unitSize: p.unitSize,
          imageUrl: p.hasImage ? `/api/products/${encodeURIComponent(String(p.id))}/image` : null,
          stock: p.stock
        }));

        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(products)
        });
      }

      response = await ai.responses.create({
        model: process.env.ALO_STAFF_AI_MODEL || "gpt-5-mini",
        max_output_tokens: 2400,
        instructions:
          "Du bist Frag ALO, interner Assistent von ALO Kiosk. " +
          "Antworte auf Deutsch mit Schweizer Rechtschreibung. " +
          "Nutze ausschliesslich die gelieferten Produktdaten. " +
          "Erfinde keine Preise oder Bestände. " +
          "Online-Snapshot-Bestände sind nicht zwingend live. " +
          "Bestandsantraege nur als Vorschau vorbereiten. Nie behaupten, sie seien gespeichert oder ausgefuehrt. " +
          "Fuer eine echte Einreichung ist eine separate bestaetigte Aktion erforderlich. " +
          "Schichtvorschlaege sind ausschliesslich Vorschauen, nie als gespeichert oder veroeffentlicht darstellen. " +
          "Frage fehlende Schichtdaten nach, verwende Tools und informiere ueber Konflikte.",
        tools,
        input
      });
    }

    const answer = response.output_text?.trim();

    if (!answer) {
      const pendingCalls = response.output.filter(
        (item: any) => item.type === "function_call"
      );

      console.error("ALO AI EMPTY RESPONSE", {
        status: response.status,
        incompleteReason: response.incomplete_details?.reason,
        outputTypes: response.output.map((item: any) => item.type),
        pendingToolCalls: pendingCalls.length,
        outputTokens: response.usage?.output_tokens
      });

      res.status(502).json({
        ok: false,
        error: pendingCalls.length
          ? "Frag ALO benötigt weitere Verarbeitungsschritte. Bitte erneut versuchen."
          : "Frag ALO konnte keine vollständige Antwort erstellen. Bitte erneut versuchen."
      });
      return;
    }

    res.json({ ok: true, answer, approvalPreview, schedulePreview, productCards });
  } catch (error) {
    console.error("STAFF AI ERROR", error);
    res.status(502).json({
      ok: false, error: "Frag ALO ist nicht erreichbar."
    });
  }
});


// ALO_STAFF_TRANSCRIBE_V40
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

router.post(
  "/transcribe",
  audioUpload.single("audio"),
  async (req, res) => {
    if (!req.file) {
      res.status(422).json({
        ok: false,
        error: "Keine Audioaufnahme erhalten."
      });
      return;
    }

    if (!["audio/mp4", "audio/m4a", "audio/x-m4a"]
      .includes(req.file.mimetype)) {
      res.status(415).json({
        ok: false,
        error: "Audioformat nicht unterstützt."
      });
      return;
    }

    if (!process.env.OPENAI_API_KEY) {
      res.status(503).json({
        ok: false,
        error: "Spracherkennung nicht konfiguriert."
      });
      return;
    }

    try {
      const ai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        timeout: 30000
      });

      const file = await toFile(
        req.file.buffer,
        "alo-voice.m4a",
        { type: req.file.mimetype }
      );

      const result = await ai.audio.transcriptions.create({
        model: "gpt-4o-mini-transcribe",
        file
      });

      res.json({
        ok: true,
        text: result.text
      });
    } catch (error) {
      console.error("ALO TRANSCRIPTION ERROR", error);
      res.status(502).json({
        ok: false,
        error: "Sprache konnte nicht erkannt werden."
      });
    }
  }
);


// ALO_STAFF_SPEAK_V40
router.post("/speak", async (req, res) => {
  const text = req.body?.text;

  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > 1500
  ) {
    res.status(422).json({
      ok: false,
      error: "Ungültiger Sprachtext."
    });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    res.status(503).json({
      ok: false,
      error: "ALO Stimme nicht konfiguriert."
    });
    return;
  }

  try {
    const ai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 30000,
      maxRetries: 1
    });

    const audio = await ai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "coral",
      input: text.trim(),
      instructions:
        "Sprich natürlich, freundlich und lebendig. " +
        "Du bist ALO, der Assistent eines Schweizer Kiosks. " +
        "Sprich gut verständlich und nicht übertrieben."
    });

    const buffer = Buffer.from(
      await audio.arrayBuffer()
    );

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (error) {
    console.error("ALO SPEECH ERROR", error);
    res.status(502).json({
      ok: false,
      error: "Sprachausgabe fehlgeschlagen."
    });
  }
});

export default router;

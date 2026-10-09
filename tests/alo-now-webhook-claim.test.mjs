
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  "src/database/shopifyWebhookEvents.ts",
  "utf8"
);

const claimStart = source.indexOf(
  "export async function claimWebhookEvent("
);
const finishStart = source.indexOf(
  "export async function finishClaimedWebhookEvent("
);

assert.ok(claimStart >= 0 && finishStart > claimStart);

function extractFunction(start, end) {
  return source.slice(start, end)
    .replace("export async function", "async function")
    .replace(/: Promise<\{[\s\S]*?\}> \{/, " {")
    .replace(/: Promise<boolean> \{/, " {")
    .replace(/id: string/g, "id")
    .replace(/attempt: number/g, "attempt")
    .replace(/allowRecovery: boolean = false/g, "allowRecovery = false")
    .replace(/status: "COMPLETED" \| "FAILED" \| "NEEDS_REVIEW"/g, "status")
    .replace(/errorMessage: string \| null = null/g, "errorMessage = null")
    .replace(/db.query<[^>]+>/g, "db.query");
}

const claimCode = extractFunction(claimStart, finishStart);
const finishCode = extractFunction(finishStart, source.length);

function harness(initialStatus = "PENDING") {
  const event = {
    id: "42",
    status: initialStatus,
    attempts: 0,
    processing_started_at: null
  };

  const db = {
    async query(sql, args) {
      if (sql.includes("attempts = attempts + 1")) {
        const [id, recovery] = args;
        const eligible =
          event.status === "PENDING" ||
          (recovery && event.status === "FAILED" && event.attempts < 3) ||
          (recovery && event.status === "PROCESSING" &&
            event.processing_started_at === "expired");

        if (id !== event.id || !eligible) return { rows: [] };

        event.status = "PROCESSING";
        event.attempts++;
        event.processing_started_at = "active";
        return { rows: [{ ...event }] };
      }

      if (sql.includes("AND attempts = $2")) {
        const [id, attempt, status] = args;
        if (
          id !== event.id ||
          attempt !== event.attempts ||
          event.status !== "PROCESSING"
        ) return { rows: [] };

        event.status = status;
        return { rows: [{ id }] };
      }

      throw new Error("Unexpected SQL");
    }
  };

  const context = vm.createContext({ db, Number, Boolean, Error });
  vm.runInContext(
    claimCode + "\n" + finishCode +
    "\nthis.claim = claimWebhookEvent;" +
    "\nthis.finish = finishClaimedWebhookEvent;",
    context
  );

  return { event, claim: context.claim, finish: context.finish };
}

test("Nur eine gleichzeitige Übernahme gelingt", async () => {
  const h = harness();
  const [a, b] = await Promise.all([
    h.claim("42"), h.claim("42")
  ]);
  assert.equal([a.claimed, b.claimed].filter(Boolean).length, 1);
  assert.equal(h.event.attempts, 1);
});

test("Abgeschlossene Webhooks werden nicht erneut übernommen", async () => {
  const h = harness();
  const first = await h.claim("42");
  assert.equal(await h.finish("42", first.attempt, "COMPLETED"), true);
  assert.equal((await h.claim("42", true)).claimed, false);
});

test("Recovery kann fehlgeschlagenen Event übernehmen", async () => {
  const h = harness("FAILED");
  assert.equal((await h.claim("42")).claimed, false);
  const result = await h.claim("42", true);
  assert.equal(result.claimed, true);
});

test("Veralteter Versuch darf neuen nicht überschreiben", async () => {
  const h = harness();
  const first = await h.claim("42");
  h.event.processing_started_at = "expired";
  const second = await h.claim("42", true);

  assert.equal(second.claimed, true);
  assert.equal(
    await h.finish("42", first.attempt, "COMPLETED"),
    false
  );
  assert.equal(
    await h.finish("42", second.attempt, "COMPLETED"),
    true
  );
});

test("Recovery respektiert maximales Retry-Limit", async () => {
  const h = harness("FAILED");
  h.event.attempts = 3;
  assert.equal((await h.claim("42", true)).claimed, false);
});


import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("src/server.ts", "utf8");

const start = source.indexOf(
  "// ALO_WEBHOOK_RECOVERY_SCHEDULER_V1"
);
const end = source.indexOf(
  "async function runWebhookRecovery()",
  start
);

assert.ok(start >= 0, "Scheduler nicht gefunden");
assert.ok(end > start, "Scheduler-Ende nicht gefunden");

const schedulerSource = source.slice(start, end);

assert.match(
  schedulerSource,
  /await runWebhookRecovery\(\)/
);

assert.doesNotMatch(
  schedulerSource,
  /await runWebhookRecoverySafely\(\)/
);

test("Recovery-Durchläufe überlappen nicht", async () => {
  let calls = 0;
  let releaseFirst;

  const firstFinished = new Promise(resolve => {
    releaseFirst = resolve;
  });

  const context = vm.createContext({
    console: {
      log() {},
      error() {}
    },
    setInterval() {
      return { unref() {} };
    },
    runWebhookRecovery: async () => {
      calls++;
      if (calls === 1) {
        await firstFinished;
      }
    }
  });

  vm.runInContext(
    schedulerSource.replace(
      "async function runWebhookRecoverySafely(): Promise<void>",
      "async function runWebhookRecoverySafely()"
    ).replace(
      "function startWebhookRecoveryScheduler(): void",
      "function startWebhookRecoveryScheduler()"
    ) +
    "\nglobalThis.testRun = runWebhookRecoverySafely;",
    context
  );

  const first = context.testRun();

  await Promise.resolve();

  await context.testRun();

  assert.equal(
    calls,
    1,
    "Zweiter Durchlauf darf nicht gleichzeitig starten"
  );

  releaseFirst();
  await first;

  await context.testRun();

  assert.equal(
    calls,
    2,
    "Nach Abschluss muss ein neuer Durchlauf möglich sein"
  );
});

test("Scheduler wird beim Serverstart aktiviert", () => {
  const listenSection = source.slice(source.lastIndexOf("app.listen("));
  assert.ok(listenSection.includes("() => {"));
  assert.match(listenSection, /void runWebhookRecoverySafely\(\);/);
  assert.ok(
    listenSection.indexOf("void runWebhookRecoverySafely()") >
    listenSection.indexOf("() => {")
  );
  const startupSection = source.slice(
    source.lastIndexOf("// WEBHOOK RECOVERY"),
    source.lastIndexOf("app.listen(")
  );
  assert.doesNotMatch(
    startupSection,
    /void runWebhookRecoverySafely\(\);/
  );

  assert.match(
    source,
    /startWebhookRecoveryScheduler\(\);/
  );

  assert.match(
    schedulerSource,
    /5 \* 60 \* 1000/
  );
});

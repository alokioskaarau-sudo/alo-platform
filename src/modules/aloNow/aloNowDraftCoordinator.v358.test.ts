import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  createAloNowDraftCoordinatorV358
} from "./aloNowDraftCoordinator.v358.js";

const requestId = randomUUID();
const reference = randomUUID();
const attemptId = randomUUID();

function activate() {
  process.env.NODE_ENV = "test";
  process.env.ALO_RUNTIME_MODE = "local_test";
  process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED = "true";
  process.env.DATABASE_URL =
    "postgresql://127.0.0.1:55433/alo_staff_test";
}

function deps() {
  const calls: string[] = [];
  const adapters = {
    async ensureIntent(_id: string) {
      calls.push("intent");
      return {
        ok: true as const,
        intent: { checkoutReference: reference }
      };
    },
    async claim(_id: string) {
      calls.push("claim");
      return {
        ok: true as const,
        requestId,
        attemptId,
        checkoutReference: reference,
        expectedTotalCHF: "14.40",
        graphql: {}
      };
    },
    async sendSimulation(_graphql: unknown, _amount: string) {
      calls.push("send");
      return { simulated: true };
    },
    async recordOutcome(
      _id: string, _attempt: string, _response: unknown
    ) {
      calls.push("outcome");
      return {
        ok: true as const,
        status: "CREATED" as const,
        draftOrderId: "gid://shopify/DraftOrder/123"
      };
    }
  };
  return { calls, adapters };
}

test("Production execution stays disabled", async () => {
  delete process.env.ALO_RUNTIME_MODE;
  const d = deps();
  const result =
    await createAloNowDraftCoordinatorV358(d.adapters)(requestId);
  assert.deepEqual(
    result,
    { ok: false, reason: "LOCAL_SIMULATION_ONLY" }
  );
  assert.deepEqual(d.calls, []);
});

test("Correct local simulation sequence", async () => {
  activate();
  const d = deps();
  const result =
    await createAloNowDraftCoordinatorV358(d.adapters)(requestId);
  assert.equal(result.ok, true);
  assert.deepEqual(
    d.calls,
    ["intent", "claim", "send", "outcome"]
  );
});

test("Transport error persists uncertain outcome", async () => {
  activate();
  const d = deps();
  d.adapters.sendSimulation = async () => {
    d.calls.push("send");
    throw Error("SIMULATED_TIMEOUT");
  };
  d.adapters.recordOutcome = async (
    _id: string, _attempt: string, response: unknown
  ) => {
    d.calls.push("outcome");
    assert.equal(response, null);
    return {
      ok: true as const,
      status: "RECONCILE_REQUIRED" as any,
      draftOrderId: ""
    };
  };

  const result =
    await createAloNowDraftCoordinatorV358(d.adapters)(requestId);
  assert.deepEqual(
    result,
    { ok: false, reason: "RECONCILE_REQUIRED" }
  );
  assert.deepEqual(
    d.calls,
    ["intent", "claim", "send", "outcome"]
  );
});

test("Failed intent never claims or sends", async () => {
  activate();
  const d = deps();
  d.adapters.ensureIntent = async () => {
    d.calls.push("intent");
    return {
      ok: false as any,
      reason: "INTENT_BLOCKED",
      intent: { checkoutReference: reference }
    };
  };

  const result =
    await createAloNowDraftCoordinatorV358(d.adapters)(requestId);
  assert.deepEqual(
    result,
    { ok: false, reason: "INTENT_BLOCKED" }
  );
  assert.deepEqual(d.calls, ["intent"]);
});

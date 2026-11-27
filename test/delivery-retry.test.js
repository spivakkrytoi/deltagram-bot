import test from "node:test";
import assert from "node:assert/strict";
import { deliverWithRetry, retryableBotDelivery } from "../src/delivery-retry.js";

test("temporary network failure retries the same code delivery", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await deliverWithRetry(async () => {
    if (++calls === 1) throw new Error("Network request for 'sendMessage' failed!");
    return { message_id: 42 };
  }, 500, { now: () => 0, sleep: async ms => { sleeps.push(ms); } });
  assert.equal(result.message_id, 42);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2000]);
});

test("do not retry blocked chats, exhausted attempts or expired codes", async () => {
  assert.equal(retryableBotDelivery({ error_code: 403 }), false);
  let calls = 0;
  await assert.rejects(deliverWithRetry(async () => {
    calls++;
    throw { error_code: 403 };
  }, 500, { now: () => 0, sleep: async () => {} }));
  assert.equal(calls, 1);
  assert.equal(await deliverWithRetry(async () => { calls++; }, 1, { now: () => 1000 }), false);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(deliverWithRetry(async () => {
    calls++;
    throw new Error("fetch failed");
  }, 500, { now: () => 0, sleep: async () => {} }));
  assert.equal(calls, 6);
});

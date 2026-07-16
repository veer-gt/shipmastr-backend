import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { readH2BRawBody } from "./h2b-raw-body.js";

class FakeRequest extends EventEmitter {
  headers: Record<string, string> = {};
  paused = false;
  pause() { this.paused = true; }
}

test("H2B raw reader accepts the exact byte limit", async () => {
  const request = new FakeRequest();
  const pending = readH2BRawBody(request as never, 4);
  request.emit("data", Buffer.from("abcd"));
  request.emit("end");
  assert.equal((await pending).toString(), "abcd");
});

test("H2B raw reader rejects one streamed byte over the limit and pauses", async () => {
  const request = new FakeRequest();
  const pending = readH2BRawBody(request as never, 4);
  request.emit("data", Buffer.from("abcde"));
  await assert.rejects(pending, (error: { status?: number; message?: string }) => {
    assert.equal(error.status, 413);
    assert.equal(error.message, "H2B_PAYLOAD_TOO_LARGE");
    return true;
  });
  assert.equal(request.paused, true);
});

test("H2B raw reader rejects a declared oversized body before listeners are attached", async () => {
  const request = new FakeRequest();
  request.headers["content-length"] = "5";
  const pending = readH2BRawBody(request as never, 4);
  assert.equal(request.listenerCount("data"), 0);
  await assert.rejects(pending, (error: { status?: number; message?: string }) => {
    assert.equal(error.status, 413);
    assert.equal(error.message, "H2B_PAYLOAD_TOO_LARGE");
    return true;
  });
});

test("H2B raw reader handles chunked input without parsing JSON", async () => {
  const request = new FakeRequest();
  const pending = readH2BRawBody(request as never, 6);
  request.emit("data", "{");
  request.emit("data", "\"x\"}");
  request.emit("end");
  assert.equal((await pending).toString(), '{"x"}');
});

test("H2B raw reader fails safely when the client aborts", async () => {
  const request = new FakeRequest();
  const pending = readH2BRawBody(request as never, 16);
  request.emit("aborted");
  await assert.rejects(pending, (error: { status?: number; message?: string }) => {
    assert.equal(error.status, 400);
    assert.equal(error.message, "H2B_REQUEST_ABORTED");
    return true;
  });
});

for (const [provider, limit] of [["SHOPIFY", 256 * 1024], ["WOOCOMMERCE", 256 * 1024], ["MAGENTO", 64 * 1024]] as const) {
  test(`${provider} cap accepts exact bytes and rejects one byte over`, async () => {
    const exactRequest = new FakeRequest();
    const exactPending = readH2BRawBody(exactRequest as never, limit);
    exactRequest.emit("data", Buffer.alloc(limit));
    exactRequest.emit("end");
    assert.equal((await exactPending).length, limit);

    const overRequest = new FakeRequest();
    const overPending = readH2BRawBody(overRequest as never, limit);
    overRequest.emit("data", Buffer.alloc(limit + 1));
    await assert.rejects(overPending, (error: { status?: number; message?: string }) => {
      assert.equal(error.status, 413);
      assert.equal(error.message, "H2B_PAYLOAD_TOO_LARGE");
      return true;
    });
  });
}

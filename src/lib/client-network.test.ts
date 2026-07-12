import assert from "node:assert/strict";
import test from "node:test";
import { clientNetworkIdentifier, pseudonymizeNetworkIdentifier } from "./client-network.js";

function request(input: { socket?: string; forwarded?: string }) {
  return {
    socket: { remoteAddress: input.socket },
    header(name: string) {
      return name.toLowerCase() === "x-forwarded-for" ? input.forwarded : undefined;
    }
  } as never;
}

test("client network extraction ignores spoofed forwarding headers by default", () => {
  assert.equal(clientNetworkIdentifier(request({ socket: "10.0.0.8", forwarded: "203.0.113.9" })), "10.0.0.8");
});

test("trusted forwarding chains select the client immediately before trusted hops", () => {
  assert.equal(
    clientNetworkIdentifier(request({ socket: "10.0.0.8", forwarded: "203.0.113.9, 10.0.0.7" }), 1),
    "203.0.113.9"
  );
});

test("malformed forwarding chains fall back to the socket address", () => {
  assert.equal(
    clientNetworkIdentifier(request({ socket: "10.0.0.8", forwarded: "not-an-ip, 10.0.0.7" }), 1),
    "10.0.0.8"
  );
});

test("network identifiers are irreversible fixed-length pseudonyms", () => {
  const first = pseudonymizeNetworkIdentifier("203.0.113.9");
  assert.equal(first, pseudonymizeNetworkIdentifier("203.0.113.9"));
  assert.match(first, /^[a-f0-9]{24}$/);
  assert.notEqual(first, "203.0.113.9");
});

import assert from "node:assert/strict";
import test from "node:test";
import type { Request, RequestHandler, Response } from "express";

import {
  buildRateLimitProxyProbeEvent,
  createRateLimitProxyProbe,
  type RateLimitProxyProbeEvent
} from "./rate-limit-proxy-probe.js";

type FakeRequestOptions = {
  headers: Record<string, string>;
  ip: string;
  socketAddress: string;
};

function fakeRequest({ headers, ip, socketAddress }: FakeRequestOptions): Request {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );

  return {
    get: (name: string) => normalizedHeaders[name.toLowerCase()],
    headers: normalizedHeaders,
    ip,
    path: "/api/health",
    socket: { remoteAddress: socketAddress }
  } as unknown as Request;
}

function invokeMiddleware(
  middleware: RequestHandler,
  { token, probeCase }: { token?: string | undefined; probeCase?: string | undefined }
): void {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["x-shipmastr-rate-limit-probe-token"] = token;
  if (probeCase !== undefined) headers["x-shipmastr-rate-limit-probe-case"] = probeCase;

  let nextCalls = 0;
  let responseMethodCalls = 0;
  const response = {
    status: () => {
      responseMethodCalls += 1;
      return response;
    },
    send: () => {
      responseMethodCalls += 1;
      return response;
    }
  } as unknown as Response;

  middleware(
    fakeRequest({ headers, ip: "10.0.0.1", socketAddress: "10.0.0.1" }),
    response,
    () => {
      nextCalls += 1;
    }
  );

  assert.equal(nextCalls, 1);
  assert.equal(responseMethodCalls, 0);
}

test("baseline reports structure without raw address values", () => {
  const event = buildRateLimitProxyProbeEvent(fakeRequest({
    headers: {},
    ip: "10.0.0.1",
    socketAddress: "10.0.0.1"
  }), "baseline");
  assert.deepEqual(event, {
    eventName: "rate_limit_proxy_probe",
    probeCase: "baseline",
    path: "/api/health",
    forwardedPresent: false,
    forwardedParseStatus: "absent",
    forwardedElementCount: 0,
    forwardedMarkerPosition: null,
    xForwardedForPresent: false,
    xForwardedForElementCount: 0,
    xForwardedForMarkerPosition: null,
    reqIpEqualsSocket: true,
    reqIpXForwardedForPosition: null,
    socketXForwardedForPosition: null
  });
  assert.equal(JSON.stringify(event).includes("10.0.0.1"), false);
});

test("distinct IPv4 markers retain independent one-based positions", () => {
  const event = buildRateLimitProxyProbeEvent(fakeRequest({
    headers: {
      forwarded: "for=203.0.113.9, for=192.0.2.30",
      "x-forwarded-for": "203.0.113.8, 198.51.100.40"
    },
    ip: "203.0.113.8",
    socketAddress: "10.0.0.2"
  }), "both-ipv4");
  assert.equal(event.forwardedMarkerPosition, 2);
  assert.equal(event.xForwardedForMarkerPosition, 2);
  assert.equal(event.reqIpXForwardedForPosition, 1);
});

test("quoted bracketed IPv6 remains attributable", () => {
  const event = buildRateLimitProxyProbeEvent(fakeRequest({
    headers: {
      forwarded: "for=unknown;proto=https, for=\"[2001:db8::1]\"",
      "x-forwarded-for": "2001:db8::2"
    },
    ip: "::ffff:10.0.0.3",
    socketAddress: "10.0.0.3"
  }), "both-ipv6");
  assert.equal(event.forwardedParseStatus, "quoted");
  assert.equal(event.forwardedMarkerPosition, 2);
  assert.equal(event.xForwardedForMarkerPosition, 1);
  assert.equal(event.reqIpEqualsSocket, true);
});

test("marker text inside a quoted Forwarded value does not match", () => {
  const event = buildRateLimitProxyProbeEvent(fakeRequest({
    headers: { forwarded: "for=\"obf;for=192.0.2.10;tail\"" },
    ip: "10.0.0.3",
    socketAddress: "10.0.0.3"
  }), "forwarded-ipv4");
  assert.equal(event.forwardedParseStatus, "quoted");
  assert.equal(event.forwardedMarkerPosition, null);
});

test("malformed quoted Forwarded input is classified without throwing", () => {
  const event = buildRateLimitProxyProbeEvent(fakeRequest({
    headers: { forwarded: "for=\"[2001:db8::1]" },
    ip: "10.0.0.4",
    socketAddress: "10.0.0.4"
  }), "both-ipv6");
  assert.equal(event.forwardedParseStatus, "malformed");
  assert.equal(event.forwardedElementCount, null);
  assert.equal(event.forwardedMarkerPosition, null);
});

test("middleware logs only for an exact token and recognized case", () => {
  const events: RateLimitProxyProbeEvent[] = [];
  const middleware = createRateLimitProxyProbe({
    token: "a".repeat(64),
    log: (event: RateLimitProxyProbeEvent) => events.push(event)
  });
  invokeMiddleware(middleware, { token: undefined, probeCase: "baseline" });
  invokeMiddleware(middleware, { token: "b".repeat(64), probeCase: "baseline" });
  invokeMiddleware(middleware, { token: "a".repeat(64), probeCase: "unknown" });
  invokeMiddleware(middleware, { token: "a".repeat(64), probeCase: "baseline" });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.probeCase, "baseline");
});

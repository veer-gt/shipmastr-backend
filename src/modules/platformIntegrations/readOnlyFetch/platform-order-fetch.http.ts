import { HttpError } from "../../../lib/httpError.js";
import { PLATFORM_READ_ERRORS } from "./platform-order-fetch.errors.js";
import type { PlatformReadHttpClient, PlatformReadHttpRequest } from "./platform-order-fetch.types.js";

export const PLATFORM_READ_TIMEOUT_MS = 8000;

export function assertReadOnlyRequest(request: PlatformReadHttpRequest) {
  if (request.method !== "GET") {
    throw new HttpError(500, PLATFORM_READ_ERRORS.MUTATION_BLOCKED);
  }
  const path = new URL(request.url).pathname.toLowerCase();
  if (/fulfillment|tracking|webhook|shipment\/create|shipments\/create|orders\/\d+/.test(path)) {
    throw new HttpError(500, PLATFORM_READ_ERRORS.MUTATION_BLOCKED);
  }
}

export const defaultPlatformReadHttpClient: PlatformReadHttpClient = async (request) => {
  assertReadOnlyRequest(request);
  const timeout = AbortSignal.timeout(request.timeoutMs || PLATFORM_READ_TIMEOUT_MS);
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    signal: timeout
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    status: response.status,
    body,
    headers
  };
};

export function retryAfterSeconds(headers: Record<string, string | undefined> | undefined) {
  const value = headers?.["retry-after"];
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";

export const rateLimitProxyProbeCases = {
  baseline: {},
  "forwarded-ipv4": { forwardedMarker: "for=192.0.2.10" },
  "xff-ipv4": { xForwardedForMarker: "198.51.100.20" },
  "both-ipv4": {
    forwardedMarker: "for=192.0.2.30",
    xForwardedForMarker: "198.51.100.40"
  },
  "both-ipv6": {
    forwardedMarker: "for=\"[2001:db8::1]\"",
    xForwardedForMarker: "2001:db8::2"
  }
} as const;

type ProbeCase = keyof typeof rateLimitProxyProbeCases;
type ForwardedParseStatus = "absent" | "simple" | "quoted" | "malformed";

export type RateLimitProxyProbeEvent = {
  eventName: "rate_limit_proxy_probe";
  probeCase: ProbeCase;
  path: string;
  forwardedPresent: boolean;
  forwardedParseStatus: ForwardedParseStatus;
  forwardedElementCount: number | null;
  forwardedMarkerPosition: number | null;
  xForwardedForPresent: boolean;
  xForwardedForElementCount: number;
  xForwardedForMarkerPosition: number | null;
  reqIpEqualsSocket: boolean;
  reqIpXForwardedForPosition: number | null;
  socketXForwardedForPosition: number | null;
};

type SplitForwardedResult = {
  status: ForwardedParseStatus;
  elements: string[] | null;
};

function splitForwardedHeader(header: string | undefined): SplitForwardedResult {
  if (header === undefined) return { status: "absent", elements: [] };

  const elements: string[] = [];
  let elementStart = 0;
  let inQuotes = false;
  let escaped = false;
  let containsQuotes = false;

  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (inQuotes && escaped) {
      escaped = false;
      continue;
    }
    if (inQuotes && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") {
      inQuotes = !inQuotes;
      containsQuotes = true;
      continue;
    }
    if (character === "," && !inQuotes) {
      elements.push(header.slice(elementStart, index).trim());
      elementStart = index + 1;
    }
  }

  if (inQuotes || escaped) return { status: "malformed", elements: null };

  elements.push(header.slice(elementStart).trim());
  return { status: containsQuotes ? "quoted" : "simple", elements };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

function normalizeAddress(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  let normalized = value.trim();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (normalized.toLowerCase().startsWith("::ffff:")) {
    normalized = normalized.slice("::ffff:".length);
  }
  return normalized;
}

function findForwardedMarkerPosition(elements: string[] | null, marker: string | undefined): number | null {
  if (elements === null || marker === undefined) return null;

  const normalizedMarker = normalizeWhitespace(marker);
  const index = elements.findIndex((element) =>
    element
      .split(";")
      .some((parameter) => normalizeWhitespace(parameter) === normalizedMarker)
  );
  return index === -1 ? null : index + 1;
}

function splitXForwardedForHeader(header: string | undefined): string[] {
  if (header === undefined) return [];
  return header.split(",").map((element) => element.trim());
}

function findExactPosition(elements: string[], value: string | undefined): number | null {
  if (value === undefined) return null;
  const normalizedValue = normalizeWhitespace(value);
  const index = elements.findIndex((element) => normalizeWhitespace(element) === normalizedValue);
  return index === -1 ? null : index + 1;
}

function findAddressPosition(elements: string[], address: string | undefined): number | null {
  const normalizedAddress = normalizeAddress(address);
  if (normalizedAddress === undefined) return null;

  const index = elements.findIndex((element) => normalizeAddress(element) === normalizedAddress);
  return index === -1 ? null : index + 1;
}

export function buildRateLimitProxyProbeEvent(
  req: Request,
  probeCase: ProbeCase
): RateLimitProxyProbeEvent {
  const forwardedHeader = req.get("forwarded");
  const xForwardedForHeader = req.get("x-forwarded-for");
  const forwarded = splitForwardedHeader(forwardedHeader);
  const xForwardedFor = splitXForwardedForHeader(xForwardedForHeader);
  const markers = rateLimitProxyProbeCases[probeCase];
  const forwardedMarker = "forwardedMarker" in markers ? markers.forwardedMarker : undefined;
  const xForwardedForMarker = "xForwardedForMarker" in markers ? markers.xForwardedForMarker : undefined;
  const requestIp = normalizeAddress(req.ip);
  const socketAddress = normalizeAddress(req.socket.remoteAddress);

  return {
    eventName: "rate_limit_proxy_probe",
    probeCase,
    path: req.path,
    forwardedPresent: forwardedHeader !== undefined,
    forwardedParseStatus: forwarded.status,
    forwardedElementCount: forwarded.elements?.length ?? null,
    forwardedMarkerPosition: findForwardedMarkerPosition(forwarded.elements, forwardedMarker),
    xForwardedForPresent: xForwardedForHeader !== undefined,
    xForwardedForElementCount: xForwardedFor.length,
    xForwardedForMarkerPosition: findExactPosition(xForwardedFor, xForwardedForMarker),
    reqIpEqualsSocket: requestIp !== undefined && socketAddress !== undefined && requestIp === socketAddress,
    reqIpXForwardedForPosition: findAddressPosition(xForwardedFor, req.ip),
    socketXForwardedForPosition: findAddressPosition(xForwardedFor, req.socket.remoteAddress)
  };
}

function tokensMatch(configuredToken: string | undefined, suppliedToken: string | undefined): boolean {
  if (configuredToken === undefined || suppliedToken === undefined) return false;

  const configuredBuffer = Buffer.from(configuredToken);
  const suppliedBuffer = Buffer.from(suppliedToken);
  return configuredBuffer.length === suppliedBuffer.length && timingSafeEqual(configuredBuffer, suppliedBuffer);
}

function isProbeCase(value: string | undefined): value is ProbeCase {
  return value !== undefined && Object.hasOwn(rateLimitProxyProbeCases, value);
}

export function createRateLimitProxyProbe(options: {
  token?: string;
  log: (event: RateLimitProxyProbeEvent) => void;
}): RequestHandler {
  return (req, _res, next) => {
    const suppliedToken = req.get("x-shipmastr-rate-limit-probe-token");
    if (!tokensMatch(options.token, suppliedToken)) {
      next();
      return;
    }

    const suppliedCase = req.get("x-shipmastr-rate-limit-probe-case");
    if (!isProbeCase(suppliedCase)) {
      next();
      return;
    }

    options.log(buildRateLimitProxyProbeEvent(req, suppliedCase));
    next();
  };
}

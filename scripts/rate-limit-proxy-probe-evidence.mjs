import { isIP } from "node:net";

const expectedCases = ["baseline", "forwarded-ipv4", "xff-ipv4", "both-ipv4", "both-ipv6"];
const structuralKeys = [
  "eventName",
  "probeCase",
  "path",
  "forwardedPresent",
  "forwardedParseStatus",
  "forwardedElementCount",
  "forwardedMarkerPosition",
  "xForwardedForPresent",
  "xForwardedForElementCount",
  "xForwardedForMarkerPosition",
  "reqIpEqualsSocket",
  "reqIpXForwardedForPosition",
  "socketXForwardedForPosition"
];
const ordinaryPayloadKeys = ["hostname", "level", "msg", "pid", "time"];
const ordinaryEnvelopeKeys = new Set([
  "errorGroups",
  "httpRequest",
  "insertId",
  "jsonPayload",
  "labels",
  "logName",
  "operation",
  "receiveTimestamp",
  "resource",
  "severity",
  "sourceLocation",
  "spanId",
  "split",
  "timestamp",
  "trace",
  "traceSampled"
]);
const structuralKeySet = new Set(structuralKeys);
const ordinaryPayloadKeySet = new Set([...structuralKeys, ...ordinaryPayloadKeys]);
const semanticallySafeEnvelopeKeys = new Set(
  [...ordinaryEnvelopeKeys].filter((key) => key !== "httpRequest")
);
const noTrustedKeys = new Set();
const forbiddenSemanticKeyTokens = new Set(["url", "uri", "ip", "ipv4", "ipv6", "address"]);
const normalizedSemanticContextTokens = [
  ...forbiddenSemanticKeyTokens,
  "candidate",
  "client",
  "remote",
  "request",
  "source",
  "text",
  "value"
];
const nullableCount = (value) => value === null || (Number.isInteger(value) && value >= 0);
const nullablePosition = (value) => value === null || (Number.isInteger(value) && value >= 1);
const forbiddenNormalizedKeys = new Set([
  "authorization",
  "body",
  "clientip",
  "cookie",
  "credential",
  "credentials",
  "env",
  "environment",
  "environmentlist",
  "environmentvariables",
  "envlist",
  "envvars",
  "forwarded",
  "headers",
  "httprequest",
  "intakesignature",
  "rawheaders",
  "remoteip",
  "requestbody",
  "requesturl",
  "serverip",
  "signature",
  "url",
  "x-forwarded-for",
  "xshipmastrintakesignature",
  "x-shipmastr-rate-limit-probe-token"
].map((key) => key.replace(/[^a-z0-9]/gu, "")));

function containsIpAddress(value) {
  const ipv4Candidates = value.match(/(?:^|[^0-9])((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?=$|[^0-9])/gu) ?? [];
  if (ipv4Candidates.some((candidate) =>
    isIP(candidate.replace(/^[^0-9]+|[^0-9]+$/gu, "")) === 4
  )) return true;
  const addressCandidates = value.match(/[0-9a-f:.%\[\]]+/giu) ?? [];
  return addressCandidates.some((candidate) => {
    const normalized = candidate.replace(/^\[|\]$/gu, "").split("%", 1)[0];
    return isIP(normalized) === 6;
  });
}

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function semanticKeyTokens(key) {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/gu)
    .filter(Boolean);
}

function containsForbiddenNormalizedSemanticSequence(normalized) {
  const states = Array.from({ length: normalized.length + 1 }, () => [false, false]);
  states[0][0] = true;
  for (let index = 0; index < normalized.length; index += 1) {
    if (!states[index][0] && !states[index][1]) continue;
    for (const token of normalizedSemanticContextTokens) {
      if (!normalized.startsWith(token, index)) continue;
      const nextIndex = index + token.length;
      if (states[index][0]) {
        states[nextIndex][forbiddenSemanticKeyTokens.has(token) ? 1 : 0] = true;
      }
      if (states[index][1]) states[nextIndex][1] = true;
    }
  }
  return states[normalized.length][1];
}

function forbiddenKey(key) {
  const normalized = normalizedKey(key);
  const semanticTokens = new Set(semanticKeyTokens(key));
  return (
    forbiddenNormalizedKeys.has(normalized) ||
    [...forbiddenSemanticKeyTokens].some((token) => semanticTokens.has(token)) ||
    containsForbiddenNormalizedSemanticSequence(normalized) ||
    normalized.includes("authorization") ||
    normalized.includes("authentication") ||
    normalized.includes("cookie") ||
    normalized.includes("token") ||
    normalized.includes("header") ||
    normalized.includes("forwarded") ||
    normalized.includes("forwarding") ||
    normalized.includes("signature") ||
    normalized.includes("credential") ||
    normalized.includes("environment") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("passwd") ||
    normalized.includes("apikey") ||
    normalized.includes("accesskey") ||
    normalized.includes("privatekey") ||
    normalized.includes("signingkey") ||
    normalized.includes("body") ||
    normalized === "env" ||
    normalized.endsWith("env") ||
    normalized.startsWith("envvar") ||
    normalized.endsWith("envvar") ||
    normalized.includes("envlist") ||
    normalized.startsWith("url") ||
    normalized.endsWith("url") ||
    normalized.startsWith("uri") ||
    normalized.endsWith("uri") ||
    normalized === "xff" ||
    normalized.startsWith("xff") ||
    normalized.endsWith("xff") ||
    /^(?:client|remote|request|response|server|socket|source|destination|peer)(?:ip|address)$/u.test(normalized)
  );
}

function stringContainsSensitiveMaterial(value, probeToken) {
  const normalized = value.toLowerCase();
  return (
    normalized.includes(probeToken.toLowerCase()) ||
    /https?:\/\//iu.test(value) ||
    /(?:^|[^a-z0-9-])x-forwarded-for\s*:/iu.test(value) ||
    /(?:^|[^a-z0-9-])forwarded\s*:/iu.test(value) ||
    /(?:^|[^a-z0-9-])for\s*=/iu.test(value) ||
    containsIpAddress(value)
  );
}

function containsSensitiveValue(value, probeToken) {
  if (typeof value === "string") {
    return stringContainsSensitiveMaterial(value, probeToken);
  }
  if (Array.isArray(value)) return value.some((child) => containsSensitiveValue(child, probeToken));
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some((child) => containsSensitiveValue(child, probeToken));
}

function containsSensitiveMaterial(value, probeToken, trustedKeys = noTrustedKeys) {
  if (typeof value === "string") return stringContainsSensitiveMaterial(value, probeToken);
  if (Array.isArray(value)) {
    return value.some((child) => containsSensitiveMaterial(child, probeToken, trustedKeys));
  }
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    (!trustedKeys.has(key) && forbiddenKey(key)) ||
    containsSensitiveMaterial(
      child,
      probeToken,
      trustedKeys === semanticallySafeEnvelopeKeys && key === "jsonPayload"
        ? ordinaryPayloadKeySet
        : noTrustedKeys
    )
  );
}

function projectValidatedEntry(entry, expectedCase) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) process.exit(4);
  if (Object.keys(entry).some((key) => !ordinaryEnvelopeKeys.has(key))) process.exit(5);
  const payload = entry.jsonPayload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) process.exit(6);
  const payloadKeys = Object.keys(payload).sort();
  const allowedPayloadKeys = [...structuralKeys, ...ordinaryPayloadKeys].sort();
  if (payloadKeys.some((key) => !allowedPayloadKeys.includes(key))) process.exit(7);
  if (structuralKeys.some((key) => !Object.hasOwn(payload, key))) process.exit(8);
  if (payload.msg !== undefined && payload.msg !== "rate limit proxy probe") process.exit(9);
  if (payload.eventName !== "rate_limit_proxy_probe") process.exit(10);
  if (payload.probeCase !== expectedCase) process.exit(11);
  if (payload.path !== "/api/health") process.exit(12);
  if (typeof payload.forwardedPresent !== "boolean") process.exit(13);
  if (![
    "absent", "simple", "quoted", "malformed"
  ].includes(payload.forwardedParseStatus)) process.exit(14);
  if (!nullableCount(payload.forwardedElementCount)) process.exit(15);
  if (!nullablePosition(payload.forwardedMarkerPosition)) process.exit(16);
  if (typeof payload.xForwardedForPresent !== "boolean") process.exit(17);
  if (!Number.isInteger(payload.xForwardedForElementCount) || payload.xForwardedForElementCount < 0) process.exit(18);
  if (!nullablePosition(payload.xForwardedForMarkerPosition)) process.exit(19);
  if (typeof payload.reqIpEqualsSocket !== "boolean") process.exit(20);
  if (!nullablePosition(payload.reqIpXForwardedForPosition)) process.exit(21);
  if (!nullablePosition(payload.socketXForwardedForPosition)) process.exit(22);

  const projected = Object.fromEntries(structuralKeys.map((key) => [key, payload[key]]));
  const projectedKeys = structuralKeys.slice().sort();
  const keys = Object.keys(projected).sort();
  if (keys.length !== projectedKeys.length || keys.some((key, index) => key !== projectedKeys[index])) process.exit(23);
  return projected;
}

function requiredRevision(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !/^shipmastr-api-staging-[a-z0-9-]+$/u.test(value)) process.exit(2);
  return value;
}

function projectGeneration(entries, probeToken) {
  if (!Array.isArray(entries) || entries.length !== 5) process.exit(3);
  if (containsSensitiveMaterial(entries, probeToken, semanticallySafeEnvelopeKeys)) process.exit(4);
  const projected = entries.map((entry, index) => projectValidatedEntry(entry, expectedCases[index]));
  if (containsSensitiveMaterial(projected, probeToken, structuralKeySet)) process.exit(24);
  return projected;
}

function assemble() {
  const matrix = JSON.parse(process.env.MATRIX_LOGS_JSON ?? "");
  const token = process.env.PROBE_TOKEN_FOR_LEAK_CHECK ?? "";
  if (
    !/^[0-9a-f]{64}$/u.test(token) ||
    matrix === null ||
    typeof matrix !== "object" ||
    Array.isArray(matrix) ||
    Object.keys(matrix).length !== 2 ||
    Object.keys(matrix).some((key) => key !== "gen1" && key !== "gen2") ||
    containsSensitiveValue(matrix, token)
  ) process.exit(2);
  const projected = {
    gen1: projectGeneration(matrix.gen1, token),
    gen2: projectGeneration(matrix.gen2, token)
  };
  const events = [
    ...projected.gen1.map((event) => ({ generation: "gen1", revision: requiredRevision("GEN1_REVISION"), event })),
    ...projected.gen2.map((event) => ({ generation: "gen2", revision: requiredRevision("GEN2_REVISION"), event }))
  ];
  const cases = expectedCases.map((probeCase, index) => ({
    probeCase,
    equal: JSON.stringify(projected.gen1[index]) === JSON.stringify(projected.gen2[index])
  }));
  const result = {
    schemaVersion: 1,
    events,
    comparison: { exactMatch: cases.every(({ equal }) => equal), cases }
  };
  if (containsSensitiveValue(result, token)) process.exit(5);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[2] === "assemble") assemble();
else process.exit(64);

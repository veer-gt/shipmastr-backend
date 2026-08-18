import { createHash } from "node:crypto";
import { isIP } from "node:net";

export class ProbeSchemaError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProbeSchemaError";
    this.code = code;
  }
}

const fail = (code) => { throw new ProbeSchemaError(code); };
const isPlainObject = (value) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const codePointLength = (value) => [...value].length;
const hasAsciiControl = (value) => /[\u0000-\u001f\u007f]/u.test(value);
const utf8Length = (value) => Buffer.byteLength(value, "utf8");
const structuralKeys = [
  "eventName", "probeCase", "path", "forwardedPresent", "forwardedParseStatus",
  "forwardedElementCount", "forwardedMarkerPosition", "xForwardedForPresent",
  "xForwardedForElementCount", "xForwardedForMarkerPosition", "reqIpEqualsSocket",
  "reqIpXForwardedForPosition", "socketXForwardedForPosition"
];
const requiredEnvelopeKeys = ["insertId", "jsonPayload", "labels", "logName", "receiveTimestamp", "resource", "severity", "timestamp"];
const optionalEnvelopeKeys = ["operation", "sourceLocation", "spanId", "trace", "traceSampled"];
const rfc3339 = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,9})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/u;
const hostname = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const int64Maximum = "9223372036854775807";

export function canonicalizeJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(object, required, optional, code) {
  if (!isPlainObject(object)) fail(code);
  const permitted = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(object, key)) || Object.keys(object).some((key) => !permitted.has(key))) fail(code);
}

function boundedString(value, min, max, code) {
  if (typeof value !== "string" || codePointLength(value) < min || codePointLength(value) > max || hasAsciiControl(value)) fail(code);
  return value;
}

function safeInteger(value, min, max, code) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}

function exactBoolean(value, code) {
  if (typeof value !== "boolean") fail(code);
}

function validateRfc3339(value, code) {
  if (typeof value !== "string" || value.length < 20 || value.length > 35 || !rfc3339.test(value) || !Number.isFinite(Date.parse(value))) fail(code);
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const days = month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (day > days) fail(code);
}

function validateExpectedLabelsObject(labels) {
  if (!isPlainObject(labels)) fail("EXPECTED_LABELS_OBJECT");
  const entries = Object.entries(labels);
  if (entries.length > 64) fail("EXPECTED_LABELS_COUNT");
  for (const [key, value] of entries) {
    boundedString(key, 1, 128, "EXPECTED_LABELS_KEY");
    boundedString(value, 0, 256, "EXPECTED_LABELS_VALUE");
  }
}

export function expectedLogLabelMetadata(labels) {
  validateExpectedLabelsObject(labels);
  const copy = { ...labels };
  const canonicalJson = canonicalizeJson(copy);
  if (utf8Length(canonicalJson) > 16_384) fail("EXPECTED_LABELS_SIZE");
  return Object.freeze({
    value: Object.freeze(copy), canonicalJson,
    sha256: createHash("sha256").update(canonicalJson).digest("hex"), count: Object.keys(copy).length
  });
}

export function parseExpectedLogLabels(raw) {
  if (typeof raw !== "string" || raw.length === 0) fail("EXPECTED_LABELS_INPUT");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail("EXPECTED_LABELS_JSON"); }
  return expectedLogLabelMetadata(parsed);
}

function containsIpAddress(value) {
  const ipv4 = value.match(/(?:^|[^0-9])((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?=$|[^0-9])/gu) ?? [];
  if (ipv4.some((candidate) => isIP(candidate.replace(/^[^0-9]+|[^0-9]+$/gu, "")) === 4)) return true;
  const candidates = value.match(/[0-9a-f:.%\[\]]+/giu) ?? [];
  return candidates.some((candidate) => isIP(candidate.replace(/^\[|\]$/gu, "").split("%", 1)[0]) === 6);
}

function containsSensitiveValue(value, probeToken) {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    return lower.includes(probeToken.toLowerCase()) || /https?:\/\//iu.test(value) ||
      /(?:^|[^a-z0-9-])x-forwarded-for\s*:/iu.test(value) ||
      /(?:^|[^a-z0-9-])forwarded\s*:/iu.test(value) ||
      /(?:^|[^a-z0-9-])for\s*=/iu.test(value) || containsIpAddress(value);
  }
  if (Array.isArray(value)) return value.some((child) => containsSensitiveValue(child, probeToken));
  return value !== null && typeof value === "object" && Object.values(value).some((child) => containsSensitiveValue(child, probeToken));
}

function validateOptions(options) {
  exactKeys(options, ["expectedCase", "expectedRevision", "expectedLabels", "probeToken"], [], "OPTIONS");
  if (!["baseline", "forwarded-ipv4", "xff-ipv4", "both-ipv4", "both-ipv6"].includes(options.expectedCase)) fail("OPTIONS_CASE");
  if (typeof options.expectedRevision !== "string" || !/^shipmastr-api-staging-[a-z0-9-]+$/u.test(options.expectedRevision)) fail("OPTIONS_REVISION");
  if (typeof options.probeToken !== "string" || !/^[0-9a-f]{64}$/u.test(options.probeToken)) fail("OPTIONS_TOKEN");
  validateExpectedLabelsObject(options.expectedLabels);
}

function validateEnvelopeScalars(entry) {
  boundedString(entry.insertId, 1, 256, "INSERT_ID");
  if (entry.logName !== "projects/shipmastr-core-prod/logs/run.googleapis.com%2Fstdout") fail("LOG_NAME");
  validateRfc3339(entry.timestamp, "TIMESTAMP");
  validateRfc3339(entry.receiveTimestamp, "RECEIVE_TIMESTAMP");
  // Cloud Logging may represent the default stdout severity as null; retain
  // the strict INFO/null boundary and reject every explicit other level.
  if (entry.severity !== null && entry.severity !== "INFO") fail("SEVERITY");
  if (Object.hasOwn(entry, "trace") && !/^projects\/shipmastr-core-prod\/traces\/[0-9a-f]{32}$/u.test(entry.trace)) fail("TRACE");
  if (Object.hasOwn(entry, "spanId") && !/^[0-9a-f]{16}$/u.test(entry.spanId)) fail("SPAN_ID");
  if (Object.hasOwn(entry, "traceSampled")) exactBoolean(entry.traceSampled, "TRACE_SAMPLED");
}

function validateResource(resource, expectedRevision) {
  exactKeys(resource, ["type", "labels"], [], "RESOURCE_KEYS");
  if (resource.type !== "cloud_run_revision") fail("RESOURCE_TYPE");
  exactKeys(resource.labels, ["project_id", "service_name", "configuration_name", "location", "revision_name"], [], "RESOURCE_LABELS_KEYS");
  const labels = resource.labels;
  if (labels.project_id !== "shipmastr-core-prod" || labels.service_name !== "shipmastr-api-staging" || labels.configuration_name !== "shipmastr-api-staging" || labels.location !== "asia-south1" || labels.revision_name !== expectedRevision) fail("RESOURCE_LABELS");
}

function validateEntryLabels(labels, expectedLabels) {
  if (!isPlainObject(labels) || !Object.hasOwn(labels, "instanceId") || !/^[0-9a-f]{1,256}$/u.test(labels.instanceId)) fail("ENTRY_LABELS_INSTANCE");
  for (const [key, value] of Object.entries(labels)) {
    if (key === "instanceId") continue;
    if (!Object.hasOwn(expectedLabels, key) || value !== expectedLabels[key]) fail("ENTRY_LABELS");
  }
}

function validateOperation(operation) {
  exactKeys(operation, [], ["id", "producer", "first", "last"], "OPERATION_KEYS");
  if (Object.keys(operation).length === 0) fail("OPERATION_KEYS");
  if (Object.hasOwn(operation, "id")) boundedString(operation.id, 1, 256, "OPERATION_ID");
  if (Object.hasOwn(operation, "producer")) boundedString(operation.producer, 1, 256, "OPERATION_PRODUCER");
  if (Object.hasOwn(operation, "first")) exactBoolean(operation.first, "OPERATION_FIRST");
  if (Object.hasOwn(operation, "last")) exactBoolean(operation.last, "OPERATION_LAST");
}

function validateSourceLocation(sourceLocation) {
  exactKeys(sourceLocation, [], ["file", "line", "function"], "SOURCE_LOCATION_KEYS");
  if (Object.keys(sourceLocation).length === 0) fail("SOURCE_LOCATION_KEYS");
  if (Object.hasOwn(sourceLocation, "file")) boundedString(sourceLocation.file, 1, 512, "SOURCE_LOCATION_FILE");
  if (Object.hasOwn(sourceLocation, "function")) boundedString(sourceLocation.function, 1, 512, "SOURCE_LOCATION_FUNCTION");
  if (Object.hasOwn(sourceLocation, "line") && (
    typeof sourceLocation.line !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/u.test(sourceLocation.line) ||
    (sourceLocation.line.length === int64Maximum.length && sourceLocation.line > int64Maximum)
  )) fail("SOURCE_LOCATION_LINE");
}

function nullableCount(value, code) {
  if (value !== null) safeInteger(value, 0, 2_147_483_647, code);
}

function nullablePosition(value, code) {
  if (value !== null) safeInteger(value, 1, 2_147_483_647, code);
}

function validatePayload(payload, expectedCase) {
  exactKeys(payload, structuralKeys, ["hostname", "level", "msg", "pid", "time"], "PAYLOAD_KEYS");
  if (payload.eventName !== "rate_limit_proxy_probe" || payload.probeCase !== expectedCase || payload.path !== "/api/health") fail("PAYLOAD_LITERAL");
  exactBoolean(payload.forwardedPresent, "PAYLOAD_FORWARDED_PRESENT");
  if (!["absent", "simple", "quoted", "malformed"].includes(payload.forwardedParseStatus)) fail("PAYLOAD_FORWARDED_STATUS");
  nullableCount(payload.forwardedElementCount, "PAYLOAD_FORWARDED_COUNT");
  nullablePosition(payload.forwardedMarkerPosition, "PAYLOAD_FORWARDED_POSITION");
  exactBoolean(payload.xForwardedForPresent, "PAYLOAD_XFF_PRESENT");
  safeInteger(payload.xForwardedForElementCount, 0, 2_147_483_647, "PAYLOAD_XFF_COUNT");
  nullablePosition(payload.xForwardedForMarkerPosition, "PAYLOAD_XFF_POSITION");
  exactBoolean(payload.reqIpEqualsSocket, "PAYLOAD_REQ_SOCKET");
  nullablePosition(payload.reqIpXForwardedForPosition, "PAYLOAD_REQ_XFF");
  nullablePosition(payload.socketXForwardedForPosition, "PAYLOAD_SOCKET_XFF");
  if (Object.hasOwn(payload, "hostname") && (typeof payload.hostname !== "string" || !hostname.test(payload.hostname))) fail("PINO_HOSTNAME");
  if (Object.hasOwn(payload, "level") && payload.level !== 30) fail("PINO_LEVEL");
  if (Object.hasOwn(payload, "msg") && payload.msg !== "rate limit proxy probe") fail("PINO_MSG");
  if (Object.hasOwn(payload, "pid")) safeInteger(payload.pid, 1, 2_147_483_647, "PINO_PID");
  if (Object.hasOwn(payload, "time")) safeInteger(payload.time, 0, Number.MAX_SAFE_INTEGER, "PINO_TIME");
}

export function validateLogEntry(entry, options) {
  validateOptions(options);
  exactKeys(entry, requiredEnvelopeKeys, optionalEnvelopeKeys, "ENTRY_KEYS");
  validateEnvelopeScalars(entry);
  validateResource(entry.resource, options.expectedRevision);
  validateEntryLabels(entry.labels, options.expectedLabels);
  if (Object.hasOwn(entry, "operation")) validateOperation(entry.operation);
  if (Object.hasOwn(entry, "sourceLocation")) validateSourceLocation(entry.sourceLocation);
  validatePayload(entry.jsonPayload, options.expectedCase);
  if (containsSensitiveValue(entry, options.probeToken)) fail("SENSITIVE_VALUE");
  const projection = Object.freeze(Object.fromEntries(structuralKeys.map((key) => [key, entry.jsonPayload[key]])));
  if (containsSensitiveValue(projection, options.probeToken)) fail("SENSITIVE_OUTPUT");
  return projection;
}

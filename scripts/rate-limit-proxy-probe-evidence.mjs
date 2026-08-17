import {
  parseExpectedLogLabels,
  ProbeSchemaError,
  validateLogEntry
} from "./rate-limit-proxy-probe-evidence-schema.mjs";

const expectedCases = ["baseline", "forwarded-ipv4", "xff-ipv4", "both-ipv4", "both-ipv6"];

const fail = (code) => { throw new ProbeSchemaError(code); };

function requiredToken() {
  const token = process.env.PROBE_TOKEN_FOR_LEAK_CHECK;
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/u.test(token)) fail("PROBE_TOKEN");
  return token;
}

function requiredRevision(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !/^shipmastr-api-staging-[a-z0-9-]+$/u.test(value)) fail("REVISION");
  return value;
}

function parseMatrix(rawMatrix) {
  if (typeof rawMatrix !== "string" || Buffer.byteLength(rawMatrix, "utf8") < 2 || Buffer.byteLength(rawMatrix, "utf8") > 262_144) fail("MATRIX_SIZE");
  let matrix;
  try { matrix = JSON.parse(rawMatrix); } catch { fail("MATRIX_JSON"); }
  if (matrix === null || typeof matrix !== "object" || Array.isArray(matrix) || Object.getPrototypeOf(matrix) !== Object.prototype) fail("MATRIX_OBJECT");
  const keys = Object.keys(matrix).sort();
  if (keys.length !== 2 || keys[0] !== "gen1" || keys[1] !== "gen2") fail("MATRIX_KEYS");
  return matrix;
}

function projectGeneration(entries, options) {
  if (!Array.isArray(entries) || entries.length !== expectedCases.length) fail("MATRIX_GENERATION");
  return entries.map((entry, index) => validateLogEntry(entry, { ...options, expectedCase: expectedCases[index] }));
}

function assemble() {
  const matrix = parseMatrix(process.env.MATRIX_LOGS_JSON);
  const token = requiredToken();
  const gen1Revision = requiredRevision("GEN1_REVISION");
  const gen2Revision = requiredRevision("GEN2_REVISION");
  const gen1Labels = parseExpectedLogLabels(process.env.GEN1_EXPECTED_LOG_LABELS_JSON).value;
  const gen2Labels = parseExpectedLogLabels(process.env.GEN2_EXPECTED_LOG_LABELS_JSON).value;
  const projected = {
    gen1: projectGeneration(matrix.gen1, { expectedRevision: gen1Revision, expectedLabels: gen1Labels, probeToken: token }),
    gen2: projectGeneration(matrix.gen2, { expectedRevision: gen2Revision, expectedLabels: gen2Labels, probeToken: token })
  };
  const events = [
    ...projected.gen1.map((event) => ({ generation: "gen1", revision: gen1Revision, event })),
    ...projected.gen2.map((event) => ({ generation: "gen2", revision: gen2Revision, event }))
  ];
  const cases = expectedCases.map((probeCase, index) => ({
    probeCase,
    equal: JSON.stringify(projected.gen1[index]) === JSON.stringify(projected.gen2[index])
  }));
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, events, comparison: { exactMatch: cases.every(({ equal }) => equal), cases } }, null, 2)}\n`);
}

try {
  if (process.argv[2] !== "assemble") process.exitCode = 64;
  else assemble();
} catch (error) {
  process.exitCode = error instanceof ProbeSchemaError ? 4 : 2;
}

import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const sourceRoot = resolve(".");
const runnerFiles = [
  "rate-limit-proxy-probe.sh",
  "rate-limit-proxy-probe-parsers.mjs",
  "rate-limit-proxy-probe-evidence.mjs",
  "rate-limit-proxy-probe-evidence-schema.mjs"
];
const evidenceDirectory = ".superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe";

function installExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function installGit(fakeBin) {
  installExecutable(join(fakeBin, "git"), `#!/usr/bin/env node
const args = process.argv.slice(2);
const head = "b".repeat(40);
const base = "a965f4314d7af02dc45c05733efaea322acb87eb";
if (args[0] === "branch" && args[1] === "--show-current") process.stdout.write("hotfix/rate-limit-proxy-probe\\n");
else if (args[0] === "merge-base") process.stdout.write(base + "\\n");
else if (args[0] === "diff") process.exit(0);
else if (args[0] === "status") process.exit(0);
else if (args[0] === "rev-parse" && args[1] === "--short=12") process.stdout.write(head.slice(0, 12) + "\\n");
else if (args[0] === "rev-parse" && args[1] === "HEAD") process.stdout.write(head + "\\n");
else process.exit(64);
`);
}

function installOpenSsl(fakeBin) {
  installExecutable(join(fakeBin, "openssl"), `#!/bin/sh
if [ "$1" != "rand" ] || [ "$2" != "-hex" ]; then exit 64; fi
case "$3" in
  32) printf '%064d\\n' 0 | tr '0' 'a' ;;
  16) printf '%032d\\n' 0 | tr '0' 'b' ;;
  6) printf '%012d\\n' 0 | tr '0' 'c' ;;
  *) exit 64 ;;
esac
`);
}

function installSleep(fakeBin) {
  installExecutable(join(fakeBin, "sleep"), `#!/bin/sh
if [ "$1" = "5" ]; then
  exec /bin/sleep 0.02
fi
exec /bin/sleep 3
`);
}

function installCurl(fakeBin) {
  installExecutable(join(fakeBin, "curl"), `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const sanitized = args.map((arg) => arg.toLowerCase().startsWith("x-shipmastr-rate-limit-probe-token:")
  ? "x-shipmastr-rate-limit-probe-token: [redacted]"
  : arg);
appendFileSync(process.env.FAKE_CALL_LOG, JSON.stringify({ command: "curl", args: sanitized }) + "\\n");
const writeIndex = args.indexOf("-w");
if (writeIndex < 0 || typeof args[writeIndex + 1] !== "string") process.exit(64);
process.stdout.write(args[writeIndex + 1].replace("%{http_code}", "200").replace(/\\\\n/gu, "\\n"));
`);
}

function installMv(fakeBin) {
  installExecutable(join(fakeBin, "mv"), `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
const args = process.argv.slice(2);
const destination = args.at(-1) ?? "";
const marker = process.env.FAKE_STATE_DIR + "/context-move-failed";
if (
  process.env.FAKE_SCENARIO === "partial_publication" &&
  destination.endsWith("/probe-context.json") &&
  !existsSync(marker)
) {
  closeSync(openSync(marker, "w"));
  process.exit(1);
}
const result = spawnSync("/bin/mv", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
}

function installGcloud(fakeBin) {
  installExecutable(join(fakeBin, "gcloud"), `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const statePath = process.env.FAKE_STATE_PATH;
const callLog = process.env.FAKE_CALL_LOG;
const load = () => JSON.parse(readFileSync(statePath, "utf8"));
const save = (state) => writeFileSync(statePath, JSON.stringify(state));
const option = (name) => args.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1);
const sanitized = args.map((arg) => arg.startsWith("--update-env-vars=")
  ? "--update-env-vars=[redacted]"
  : arg);
appendFileSync(callLog, JSON.stringify({ command: "gcloud", args: sanitized }) + "\\n");

const structuralCases = ["baseline", "forwarded-ipv4", "xff-ipv4", "both-ipv4", "both-ipv6"];
const labelsForGeneration = (generation) => generation === "gen1"
  ? { environment: "diagnostic", matrixGeneration: "one" }
  : { environment: "diagnostic", matrixGeneration: "two" };
const event = (probeCase, index, cell, scenario) => ({
  insertId: "probe-" + cell.generation + "-" + String(index),
  jsonPayload: {
    eventName: "rate_limit_proxy_probe",
    probeCase,
    path: "/api/health",
    forwardedPresent: probeCase.includes("forwarded") || probeCase.includes("both"),
    forwardedParseStatus: probeCase === "baseline" || probeCase === "xff-ipv4" ? "absent" : "simple",
    forwardedElementCount: probeCase === "baseline" || probeCase === "xff-ipv4" ? null : 1,
    forwardedMarkerPosition: null,
    xForwardedForPresent: probeCase !== "baseline" && probeCase !== "forwarded-ipv4",
    xForwardedForElementCount: probeCase === "baseline" || probeCase === "forwarded-ipv4" ? 0 : 1,
    xForwardedForMarkerPosition: null,
    reqIpEqualsSocket: true,
    reqIpXForwardedForPosition: null,
    socketXForwardedForPosition: null,
    hostname: "probe-host",
    level: 30,
    msg: "rate limit proxy probe",
    pid: 123,
    time: 1786924800000
  },
  labels: {
    instanceId: "abcdef0123456789",
    ...labelsForGeneration(cell.generation),
    ...(scenario === "log_label_mismatch" && cell.generation === "gen2"
      ? { matrixGeneration: "changed" }
      : {})
  },
  logName: "projects/shipmastr-core-prod/logs/run.googleapis.com%2Fstdout",
  receiveTimestamp: "2026-08-17T12:00:01Z",
  resource: {
    type: "cloud_run_revision",
    labels: {
      project_id: "shipmastr-core-prod",
      service_name: "shipmastr-api-staging",
      configuration_name: "shipmastr-api-staging",
      location: "asia-south1",
      revision_name: cell.revision
    }
  },
  severity: "INFO",
  timestamp: "2026-08-17T12:00:00Z"
});

function stagingService(state) {
  if (state.cells.gen1.started || state.cells.gen2.started) state.stagingDescribeAfterDeploy += 1;
  for (const cell of Object.values(state.cells)) {
    if (cell.late && state.stagingDescribeAfterDeploy >= 3) cell.visible = true;
  }
  save(state);
  const traffic = [{ revisionName: state.originalRevision, percent: 100 }];
  for (const cell of Object.values(state.cells)) {
    if (!cell.visible || cell.removed) continue;
    const entry = {
      tag: cell.tag,
      revisionName: cell.revision,
      percent: 0,
      url: "https://" + cell.tag + "---staging.example.test"
    };
    traffic.push(entry);
    if (cell.ambiguous) traffic.push({ ...entry });
  }
  const env = [{ name: "COURIER_AUDIT_INTAKE_ENABLED", value: "false" }];
  if (state.tokenPresent) env.push({ name: "RATE_LIMIT_PROXY_PROBE_TOKEN", value: state.token });
  return {
    metadata: { name: "shipmastr-api-staging", generation: 20 },
    spec: { template: { spec: { containerConcurrency: 80, containers: [{ env }] } } },
    status: {
      url: "https://shipmastr-api-staging.example.test",
      latestCreatedRevisionName: state.originalRevision,
      latestReadyRevisionName: state.originalRevision,
      traffic
    }
  };
}

function productionService(state) {
  return {
    metadata: {
      name: "shipmastr-api",
      generation: 12,
      annotations: { "run.googleapis.com/ingress": "all" },
      labels: { "cloud.googleapis.com/location": "asia-south1" }
    },
    spec: { traffic: [{ revisionName: state.productionRevision, percent: 100 }] },
    status: {
      latestCreatedRevisionName: state.productionRevision,
      latestReadyRevisionName: state.productionRevision,
      traffic: [{ revisionName: state.productionRevision, percent: 100 }]
    }
  };
}

function revision(state, name) {
  if (name === state.originalRevision) {
    return {
      metadata: { name },
      status: { imageDigest: state.imageDigest },
      spec: {
        containerConcurrency: 80,
        containers: [{ image: state.imageUri + "@" + state.imageDigest, env: [
          { name: "COURIER_AUDIT_INTAKE_ENABLED", value: "false" }
        ] }]
      }
    };
  }
  if (name === state.productionRevision) {
    return {
      metadata: { name },
      spec: { containerConcurrency: 40, containers: [{ image: state.imageUri + "@" + state.imageDigest }] }
    };
  }
  const cell = Object.values(state.cells).find((candidate) => candidate.revision === name);
  if (!cell) process.exit(44);
  return {
    metadata: {
      name,
      annotations: { "run.googleapis.com/execution-environment": cell.generation },
      labels: labelsForGeneration(cell.generation)
    },
    spec: {
      containerConcurrency: 40,
      containers: [{ image: cell.image, env: [
        { name: "COURIER_AUDIT_INTAKE_ENABLED", value: "false" },
        { name: "RATE_LIMIT_PROXY_PROBE_TOKEN", value: state.token }
      ] }]
    }
  };
}

if (args[0] === "config" && args[1] === "get-value" && args[2] === "project") {
  process.stdout.write("shipmastr-core-prod\\n");
} else if (args[0] === "run" && args[1] === "services" && args[2] === "describe") {
  const state = load();
  const service = args[3];
  process.stdout.write(JSON.stringify(service === "shipmastr-api" ? productionService(state) : stagingService(state)) + "\\n");
} else if (args[0] === "run" && args[1] === "revisions" && args[2] === "describe") {
  const state = load();
  process.stdout.write(JSON.stringify(revision(state, args[3])) + "\\n");
} else if (args[0] === "beta" && args[1] === "run" && args[2] === "domain-mappings") {
  process.stdout.write("[]\\n");
} else if (args[0] === "builds" && args[1] === "submit") {
  process.exit(0);
} else if (args[0] === "artifacts" && args[1] === "docker" && args[2] === "images" && args[3] === "describe") {
  process.stdout.write(load().imageDigest + "\\n");
} else if (args[0] === "run" && args[1] === "deploy") {
  const state = load();
  const generation = option("--execution-environment");
  const cell = state.cells[generation];
  cell.started = true;
  cell.tag = option("--tag");
  cell.image = option("--image");
  state.tokenPresent = true;
  if (state.scenario === "ambiguous_ownership" && generation === "gen1") {
    cell.visible = true;
    cell.ambiguous = true;
    save(state);
    process.exit(23);
  }
  if (["deploy_timeout_late_tag", "deploy_timeout_unresolved"].includes(state.scenario) && generation === "gen1") {
    cell.late = state.scenario === "deploy_timeout_late_tag";
    state.hangingPids.push(process.pid);
    save(state);
    setInterval(() => {}, 1000);
  } else if ((state.scenario === "signal" || state.scenario === "late_second_signal") && generation === "gen1") {
    cell.visible = true;
    state.hangingPids.push(process.pid);
    save(state);
    setInterval(() => {}, 1000);
  } else {
    cell.visible = true;
    save(state);
  }
} else if (args[0] === "run" && args[1] === "services" && args[2] === "update-traffic") {
  const state = load();
  const tag = option("--remove-tags");
  const cell = Object.values(state.cells).find((candidate) => candidate.tag === tag);
  if (!cell) process.exit(45);
  if (state.scenario === "cleanup_failure" && cell.generation === "gen1") process.exit(46);
  if (["cleanup_timeout", "late_second_signal"].includes(state.scenario) && !state.cleanupHangUsed) {
    state.cleanupHangUsed = true;
    state.hangingPids.push(process.pid);
    save(state);
    setInterval(() => {}, 1000);
  } else {
    cell.removed = true;
    save(state);
  }
} else if (args[0] === "run" && args[1] === "services" && args[2] === "update") {
  const state = load();
  if (args.includes("--remove-env-vars=RATE_LIMIT_PROXY_PROBE_TOKEN")) state.tokenPresent = false;
  save(state);
} else if (args[0] === "logging" && args[1] === "read") {
  const state = load();
  const revisionName = args[2]?.match(/resource\.labels\.revision_name="([^"]+)"/u)?.[1];
  const cell = Object.values(state.cells).find((candidate) => candidate.revision === revisionName);
  if (!cell) process.exit(44);
  process.stdout.write(JSON.stringify(structuralCases.map((probeCase, index) =>
    event(probeCase, index, cell, state.scenario))) + "\\n");
} else {
  process.exit(64);
}
`);
}

function readCalls(callLog) {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function readState(statePath) {
  try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return {}; }
}

function killRecordedProcesses(statePath) {
  const state = readState(statePath);
  for (const pid of state.hangingPids ?? []) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

export async function runFakeProbe({ scenario = "success", signals = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rate-limit-proxy-probe-runner-"));
  const scriptsDirectory = join(root, "scripts");
  const fakeBin = join(root, "fake-bin");
  const stateDirectory = join(root, "fake-state");
  const statePath = join(stateDirectory, "state.json");
  const callLog = join(stateDirectory, "calls.jsonl");
  mkdirSync(scriptsDirectory, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(join(root, evidenceDirectory), { recursive: true });
  for (const file of runnerFiles) {
    copyFileSync(join(sourceRoot, "scripts", file), join(scriptsDirectory, basename(file)));
  }
  chmodSync(join(scriptsDirectory, "rate-limit-proxy-probe.sh"), 0o755);

  const state = {
    scenario,
    originalRevision: "shipmastr-api-staging-original",
    productionRevision: "shipmastr-api-prod-r1",
    imageUri: "asia-south1-docker.pkg.dev/shipmastr-core-prod/shipmastr/shipmastr-api",
    imageDigest: "sha256:" + "d".repeat(64),
    token: "a".repeat(64),
    tokenPresent: false,
    stagingDescribeAfterDeploy: 0,
    cleanupHangUsed: false,
    hangingPids: [],
    cells: {
      gen1: {
        generation: "gen1",
        revision: "shipmastr-api-staging-gen1-probe",
        started: false,
        visible: false,
        removed: false,
        ambiguous: false,
        late: false,
        tag: "",
        image: ""
      },
      gen2: {
        generation: "gen2",
        revision: "shipmastr-api-staging-gen2-probe",
        started: false,
        visible: false,
        removed: false,
        ambiguous: false,
        late: false,
        tag: "",
        image: ""
      }
    }
  };
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(callLog, "");
  installGit(fakeBin);
  installOpenSsl(fakeBin);
  installSleep(fakeBin);
  installCurl(fakeBin);
  installMv(fakeBin);
  installGcloud(fakeBin);

  const child = spawn("bash", ["scripts/rate-limit-proxy-probe.sh"], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_CALL_LOG: callLog,
      FAKE_SCENARIO: scenario,
      FAKE_STATE_DIR: stateDirectory,
      FAKE_STATE_PATH: statePath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let harnessTimedOut = false;
  let sentSignals = 0;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const signalPoll = setInterval(() => {
    if (sentSignals >= signals.length) return;
    const calls = readCalls(callLog);
    const deploySeen = calls.some(({ command, args }) =>
      command === "gcloud" && args[0] === "run" && args[1] === "deploy"
    );
    const cleanupMutationSeen = calls.some(({ command, args }) =>
      command === "gcloud" && args[0] === "run" && args[1] === "services" && args[2] === "update-traffic"
    );
    const shouldSend = sentSignals === 0 ? deploySeen : cleanupMutationSeen;
    if (shouldSend) {
      try { child.kill(signals[sentSignals]); } catch {}
      sentSignals += 1;
    }
  }, 10);

  const harnessTimer = setTimeout(() => {
    harnessTimedOut = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch {
      try { child.kill("SIGKILL"); } catch {}
    }
    killRecordedProcesses(statePath);
  }, 25_000);

  const outcome = await new Promise((resolveOutcome) => {
    child.on("close", (status, signal) => resolveOutcome({ status, signal }));
  });
  clearInterval(signalPoll);
  clearTimeout(harnessTimer);
  killRecordedProcesses(statePath);

  const resultPath = join(root, evidenceDirectory, "probe-results.json");
  const contextPath = join(root, evidenceDirectory, "probe-context.json");
  const lockPath = join(root, evidenceDirectory, ".rate-limit-proxy-probe.lock");
  return {
    ...outcome,
    calls: readCalls(callLog),
    context: existsSync(contextPath) ? JSON.parse(readFileSync(contextPath, "utf8")) : undefined,
    contextExists: existsSync(contextPath),
    harnessTimedOut,
    lockExists: existsSync(lockPath),
    result: existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : undefined,
    resultExists: existsSync(resultPath),
    root,
    state: readState(statePath),
    stderr,
    stdout,
    dispose() {
      killRecordedProcesses(statePath);
      rmSync(root, { recursive: true, force: true });
    }
  };
}

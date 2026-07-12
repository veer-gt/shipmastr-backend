import { execFileSync } from "node:child_process";

export const POSTGRES_CONTAINER = "shipmastr-postgres";
export const LOCAL_HOST = "127.0.0.1";
export const LOCAL_PORT = 5433;
export const POSTGRES_PORT = 5432;
export const POSTGRES_IMAGE = /(?:^|\/)postgres:16(?:$|@)/;
export const POSTGRES_VOLUME_DESTINATION = "/var/lib/postgresql/data";

function commandOutput(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
  } catch (error) {
    const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : String(error?.stderr ?? "");
    const stdout = Buffer.isBuffer(error?.stdout) ? error.stdout.toString("utf8") : String(error?.stdout ?? "");
    const detail = [stderr, stdout].join(" ").replace(/\s+/g, " ").trim().slice(0, 240);
    throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
  }
}

export function runContainer(args, options = {}) {
  return commandOutput("container", args, options);
}

export function listContainers() {
  const output = runContainer(["list", "--all", "--format", "json"]);
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("Apple Container returned an invalid container inventory");
  return parsed;
}

export function inspectPostgresContainer() {
  const record = listContainers().find((entry) => entry?.id === POSTGRES_CONTAINER || entry?.configuration?.id === POSTGRES_CONTAINER);
  if (!record) throw new Error(`Existing ${POSTGRES_CONTAINER} container was not found; refusing to create or replace it`);
  const config = record.configuration ?? {};
  const state = record.status?.state ?? "unknown";
  const image = String(config.image?.reference ?? "");
  const mount = (config.mounts ?? []).find((item) => item?.destination === POSTGRES_VOLUME_DESTINATION);
  const volume = mount?.type?.volume?.name ?? "";
  const publishedPort = (config.publishedPorts ?? []).find((item) => (
    item?.hostAddress === LOCAL_HOST && Number(item?.hostPort) === LOCAL_PORT && Number(item?.containerPort) === POSTGRES_PORT && item?.proto === "tcp"
  ));
  if (!POSTGRES_IMAGE.test(image)) throw new Error(`Refusing unexpected PostgreSQL image: ${image || "missing"}`);
  if (!volume) throw new Error("Refusing PostgreSQL container without an identified persistent data volume");
  if (!publishedPort) throw new Error(`Refusing PostgreSQL container without the expected ${LOCAL_HOST}:${LOCAL_PORT} binding`);
  return { record, config, state, image, volume, publishedPort };
}

export function assertLocalTarget(host = LOCAL_HOST, port = LOCAL_PORT) {
  if (!["127.0.0.1", "localhost"].includes(String(host).toLowerCase())) {
    throw new Error(`Refusing non-local database host: ${host}`);
  }
  if (Number(port) !== LOCAL_PORT) throw new Error(`Refusing unexpected local database port: ${port}`);
  return true;
}

export function pgIsReady() {
  try {
    const output = commandOutput("pg_isready", ["-h", LOCAL_HOST, "-p", String(LOCAL_PORT)]).trim();
    return { ready: true, output };
  } catch (error) {
    return { ready: false, output: error instanceof Error ? error.message : "pg_isready failed" };
  }
}

export function waitForPostgres(timeoutMs = 30_000) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const result = pgIsReady();
    if (result.ready) return result.output;
    last = result.output;
    const until = Date.now() + 500;
    while (Date.now() < until) {}
  }
  throw new Error(`PostgreSQL did not become ready on ${LOCAL_HOST}:${LOCAL_PORT}${last ? ` (${last})` : ""}`);
}

export function runPsql(database, sql) {
  if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error("Refusing an unsafe database identifier");
  return runContainer([
    "exec", "--user", "postgres", POSTGRES_CONTAINER,
    "psql", "-d", database, "-v", "ON_ERROR_STOP=1", "-Atqc", sql
  ]).trim();
}

export function quoteIdentifier(identifier) {
  if (!/^[a-zA-Z0-9_]+$/.test(identifier)) throw new Error("Refusing an unsafe database identifier");
  return `"${identifier}"`;
}

export function quoteLiteral(value) {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error("Refusing an unsafe database value");
  return `'${value}'`;
}

export function redactUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.username = "<local-user>";
    parsed.password = "<redacted>";
    return parsed.toString();
  } catch {
    return "<local scratch connection>";
  }
}

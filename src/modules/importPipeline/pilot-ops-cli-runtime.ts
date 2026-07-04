import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { FormatPackActivationService } from "./format-pack-activation.service.js";
import { FormatPackFixtureRunner } from "./format-pack-fixture-runner.service.js";
import { FormatPackParserService } from "./format-pack-parser.service.js";
import { ImportCorrectionApplyService } from "./import-correction-apply.service.js";
import { ImportCorrectionPlannerService } from "./import-correction-planner.service.js";
import { ImportFileService } from "./import-file.service.js";
import { LocalFileFixtureContentProvider } from "./fixture-content-provider.js";
import { PilotOpsService, type PilotOpsDeps } from "./pilot-ops.service.js";
import { RecoveryReportService } from "./recovery-report.service.js";
import { ShadowAccountProvisioningService } from "./shadow-account-provisioning.service.js";
import { ShadowLedgerPostingService } from "./shadow-ledger-posting.service.js";
import { StagingRowService } from "./staging-row.service.js";
import { LedgerService } from "../walletLedger/ledger.service.js";

export const LOCAL_RUNTIME_REFUSAL = "W0 pilot wrapper is local/internal only. Refusing cloud or production-like runtime.";

type CliArgv = readonly string[];
let cliPrismaClient: PrismaClient | null = null;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requireMethod(target: Record<string, unknown>, methodName: string, code: string) {
  if (typeof target[methodName] !== "function") throw new Error(code);
}

export function assertPilotOpsCliClient(client: unknown): asserts client is NonNullable<PilotOpsDeps["client"]> {
  const root = asRecord(client);
  const accountTypeConfig = asRecord(root.accountTypeConfig);
  const formatPackVersion = asRecord(root.formatPackVersion);
  requireMethod(accountTypeConfig, "findMany", "W0_PILOT_CLI_ACCOUNT_TYPE_CONFIG_CLIENT_MISSING");
  requireMethod(formatPackVersion, "findFirst", "W0_PILOT_CLI_FORMAT_PACK_VERSION_CLIENT_MISSING");
}

export function createPilotOpsServiceForCli(input: {
  client?: unknown;
  cwd?: string;
} = {}) {
  const client = input.client ?? cliPrisma();
  assertPilotOpsCliClient(client);
  const contentProvider = new LocalFileFixtureContentProvider(input.cwd ?? process.cwd());
  const ledger = new LedgerService(client as never);
  const stagingRows = new StagingRowService(client as never);
  const parser = new FormatPackParserService(client as never, stagingRows);
  const provisioning = new ShadowAccountProvisioningService(client as never, ledger);
  return new PilotOpsService({
    client,
    contentProvider,
    fixtureRunner: new FormatPackFixtureRunner(contentProvider, client as never, parser),
    parser,
    importFiles: new ImportFileService(client as never),
    shadowPosting: new ShadowLedgerPostingService(client as never, ledger, provisioning),
    recoveryReports: new RecoveryReportService(client as never),
    correctionPlanner: new ImportCorrectionPlannerService(client as never, parser, contentProvider),
    correctionApply: new ImportCorrectionApplyService(client as never, ledger, provisioning),
    activation: new FormatPackActivationService(client as never)
  });
}

function cliPrisma() {
  cliPrismaClient ??= new PrismaClient({ log: [] });
  return cliPrismaClient;
}

export async function closePilotOpsCliRuntime() {
  if (!cliPrismaClient) return;
  await cliPrismaClient.$disconnect();
  cliPrismaClient = null;
}

export function argValue(argv: CliArgv, name: string) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function hasArg(argv: CliArgv, name: string) {
  return argv.includes(name);
}

export function commandName(argv: CliArgv) {
  const raw = argv[0] || "readiness";
  return raw.startsWith("w0:") ? raw.slice(3) : raw;
}

export function assertLocalRuntime(source: NodeJS.ProcessEnv = process.env) {
  const nodeEnv = String(source.NODE_ENV || "").trim().toLowerCase();
  const appEnv = String(source.APP_ENV || "").trim().toLowerCase();
  if (nodeEnv === "production" || appEnv === "production" || source.K_SERVICE || source.CLOUD_RUN_JOB) {
    throw new Error(LOCAL_RUNTIME_REFUSAL);
  }
}

export function requiredArg(argv: CliArgv, name: string) {
  const value = argValue(argv, name);
  if (!value || !String(value).trim()) throw new Error(`${name} is required`);
  return String(value).trim();
}

export function optionalArg(argv: CliArgv, name: string) {
  const value = argValue(argv, name);
  return value && String(value).trim() ? String(value).trim() : undefined;
}

export function principal(argv: CliArgv, name = "--created-by") {
  return optionalArg(argv, name) || "import_pipeline_w0";
}

export function csvPath(argv: CliArgv) {
  return optionalArg(argv, "--file") || optionalArg(argv, "--csv");
}

export function localFileContent(localPath: string | undefined, cwd = process.cwd()) {
  if (!localPath) return undefined;
  return readFileSync(resolve(cwd, localPath), "utf8");
}

export function csvContent(argv: CliArgv, cwd = process.cwd()) {
  return localFileContent(csvPath(argv), cwd);
}

export function requiredLocalFileContent(argv: CliArgv, name: string, cwd = process.cwd()) {
  return readFileSync(resolve(cwd, requiredArg(argv, name)), "utf8");
}

export function baseImportInput(argv: CliArgv, cwd = process.cwd()) {
  return {
    csvContent: csvContent(argv, cwd),
    ordersCsvContent: localFileContent(optionalArg(argv, "--orders-file"), cwd),
    storagePath: optionalArg(argv, "--storage-path"),
    expectedFileHash: optionalArg(argv, "--expected-file-hash") || optionalArg(argv, "--file-hash"),
    source: requiredArg(argv, "--source"),
    counterparty: optionalArg(argv, "--counterparty"),
    brandOrgId: optionalArg(argv, "--brand-org-id"),
    period: optionalArg(argv, "--period"),
    formatPackVersionId: optionalArg(argv, "--format-pack-version-id"),
    statedTotalMinor: optionalArg(argv, "--stated-total-minor"),
    createdBy: principal(argv)
  };
}

export function requireExecute(argv: CliArgv) {
  if (!hasArg(argv, "--execute")) throw new Error("--execute is required for this mutating command");
}

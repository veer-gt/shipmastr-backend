import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { InMemoryFixtureContentProvider } from "./fixture-content-provider.js";
import { FormatPackActivationService } from "./format-pack-activation.service.js";
import { formatPackDefinitionValidator } from "./format-pack-definition.validator.js";
import { FormatPackFixtureRunner } from "./format-pack-fixture-runner.service.js";
import { FormatPackParserService } from "./format-pack-parser.service.js";
import { ImportPipelineError } from "./import-pipeline.errors.js";
import { PilotOpsService } from "./pilot-ops.service.js";
import { StagingRowService } from "./staging-row.service.js";
import {
  SYNTHETIC_BIGSHIP_COUNTERPARTY,
  SYNTHETIC_BIGSHIP_PACK_KEY,
  SYNTHETIC_BIGSHIP_SOURCE,
  SYNTHETIC_BIGSHIP_VERSION,
  SyntheticBigshipFormatPackSeedService,
  SyntheticOrderReferenceResolver,
  syntheticBigshipFormatPackDefinition,
  syntheticBigshipPackPreview
} from "./synthetic-bigship-format-pack.js";

const fixtureRoot = join(process.cwd(), "fixtures/pilot/synthetic");
const misPath = "fixtures/pilot/synthetic/bigship-mis-2026-07.csv";
const misContent = readFileSync(join(fixtureRoot, "bigship-mis-2026-07.csv"), "utf8");
const ordersContent = readFileSync(join(fixtureRoot, "shopify-orders-2026-07.csv"), "utf8");
const manifestContent = readFileSync(join(fixtureRoot, "traps-manifest.json"), "utf8");

function makeSeedHarness() {
  const state = {
    packs: [] as any[],
    versions: [] as any[],
    fixtures: [] as any[],
    runs: [] as any[],
    importFiles: [] as any[],
    stagingRows: [] as any[],
    journalEntries: [] as any[]
  };

  function packFor(version: any) {
    return state.packs.find((pack) => pack.id === version.packId) ?? null;
  }

  function versionMatches(version: any, where: any) {
    if (where.id && version.id !== where.id) return false;
    if (where.packId && version.packId !== where.packId) return false;
    if (where.version && version.version !== where.version) return false;
    if (where.status && version.status !== where.status) return false;
    if (where.pack?.packKey && packFor(version)?.packKey !== where.pack.packKey) return false;
    if (where.pack?.source && packFor(version)?.source !== where.pack.source) return false;
    if (where.pack?.courierCode && packFor(version)?.courierCode !== where.pack.courierCode) return false;
    return true;
  }

  function withPack(version: any, include: any) {
    return include?.pack ? { ...version, pack: packFor(version) } : version;
  }

  const client = {
    $transaction: async (callback: any) => callback(client),
    formatPack: {
      findUnique: async ({ where }: any) => state.packs.find((pack) => pack.packKey === where.packKey) ?? null,
      create: async ({ data }: any) => {
        const pack = { id: `pack_${state.packs.length + 1}`, createdAt: new Date(), ...data };
        state.packs.push(pack);
        return pack;
      }
    },
    formatPackVersion: {
      findUnique: async ({ where, include }: any) => {
        const version = state.versions.find((item) => item.id === where.id) ?? null;
        return version ? withPack(version, include) : null;
      },
      findFirst: async ({ where, include }: any) => {
        const records = state.versions.filter((version) => versionMatches(version, where));
        const record = records[records.length - 1] ?? null;
        return record ? withPack(record, include) : null;
      },
      findMany: async ({ where, include }: any) => state.versions
        .filter((version) => versionMatches(version, where))
        .map((version) => withPack(version, include)),
      create: async ({ data, include }: any) => {
        const version = {
          id: `version_${state.versions.length + 1}`,
          createdAt: new Date(Date.parse("2026-07-04T00:00:00.000Z") + state.versions.length),
          approvedBy: null,
          activatedAt: null,
          retiredAt: null,
          ...data
        };
        state.versions.push(version);
        return withPack(version, include);
      },
      update: async ({ where, data, include }: any) => {
        const version = state.versions.find((item) => item.id === where.id);
        Object.assign(version, data);
        return withPack(version, include);
      },
      updateMany: async ({ where, data }: any) => {
        const records = state.versions.filter((version) => versionMatches(version, where));
        records.forEach((version) => Object.assign(version, data));
        return { count: records.length };
      }
    },
    formatPackFixture: {
      findFirst: async ({ where }: any) => state.fixtures.find((fixture) => fixture.packVersionId === where.packVersionId && fixture.fixtureName === where.fixtureName) ?? null,
      findMany: async ({ where }: any) => state.fixtures.filter((fixture) => !where.packVersionId || fixture.packVersionId === where.packVersionId),
      create: async ({ data }: any) => {
        const fixture = { id: `fixture_${state.fixtures.length + 1}`, createdAt: new Date(), ...data };
        state.fixtures.push(fixture);
        return fixture;
      },
      update: async ({ where, data }: any) => {
        const fixture = state.fixtures.find((item) => item.id === where.id);
        Object.assign(fixture, data);
        return fixture;
      }
    },
    formatPackTestRun: {
      create: async ({ data }: any) => {
        const run = { id: `run_${state.runs.length + 1}`, createdAt: new Date(), ...data };
        state.runs.push(run);
        return run;
      },
      findFirst: async ({ where }: any) => [...state.runs].reverse().find((run) => run.packVersionId === where.packVersionId) ?? null
    }
  };
  const parser = new FormatPackParserService(client as any, new StagingRowService({} as any));
  const runner = new FormatPackFixtureRunner(new InMemoryFixtureContentProvider({ [misPath]: misContent }), client as any, parser);
  const activation = new FormatPackActivationService(client as any);
  const service = new SyntheticBigshipFormatPackSeedService(client as any, runner, activation);
  return { client, service, state };
}

describe("W0D-H3 synthetic Bigship format pack", () => {
  it("builds a valid definition and keeps MISC ADJ as a visible trap", async () => {
    const definition = syntheticBigshipFormatPackDefinition();
    assert.equal(formatPackDefinitionValidator.validate(definition).definitionHash.length, 64);
    assert.equal((definition.charge_code_map as any)["MISC ADJ"], undefined);

    const preview = await syntheticBigshipPackPreview({ misContent, ordersContent, manifestContent });
    assert.equal(preview.identity.packKey, SYNTHETIC_BIGSHIP_PACK_KEY);
    assert.equal(preview.expectedSummary.row_count, 70);
    assert.equal(preview.expectedSummary.raw_file_total_minor, "667470");
    assert.equal(preview.expectedSummary.all_rows_total_minor, "667470");
    assert.equal(preview.expectedSummary.postable_total_minor, "636020");
    assert.equal(preview.expectedSummary.file_ties, true);
    assert.equal(preview.parserPreview.fileTies, true);
    assert.equal(preview.parserPreview.fileExceptionCode, null);
    assert.equal(preview.parserPreview.exceptionCodes.includes("TOTAL_MISMATCH"), false);
    assert.equal(preview.parserPreview.exceptionCodes.includes("UNRESOLVED_SHIPMENT"), true);
    assert.equal(preview.parserPreview.exceptionCodes.includes("UNKNOWN_CHARGE_CODE"), true);
    assert.equal(preview.expectedSummary.event_class_counts.weight_dispute_debit, 4);
    assert.equal(preview.expectedSummary.event_class_counts.weight_dispute_credit, 1);
    assert.equal(preview.expectedSummary.event_class_counts.rto_freight_charged, 2);
    const manifest = JSON.parse(manifestContent);
    assert.equal(manifest.misDuplicateRows, 1);
    assert.equal(manifest.traps.some((trap: any) => trap.id === "T3_same_awb_rebill"), true);
  });

  it("parses synthetic date formats and decimal kg values", async () => {
    const parser = new FormatPackParserService({
      formatPackVersion: {
        findUnique: async () => ({
          id: "version_1",
          packId: "pack_1",
          version: SYNTHETIC_BIGSHIP_VERSION,
          definition: syntheticBigshipFormatPackDefinition(),
          definitionHash: "hash",
          minEngineVersion: "w0.synthetic.1",
          status: "draft",
          createdBy: "import_pipeline_w0"
        }),
        findFirst: async () => null
      }
    } as any);
    const result = await parser.dryRunParseCsv({
      csvContent: [
        "AWB No,Order Ref,Charge Head,Net Amount,Booking Date,Declared Wt (Kg),Charged Wt (Kg)",
        "BSHPTEST1,#1001,FREIGHT,45.00,21-Jul-26,0.500,1.000",
        "BSHPTEST2,#1002,FREIGHT,45.00,26/07/2026,0.250,0.750"
      ].join("\n"),
      formatPackVersionId: "version_1",
      statedTotalMinor: "9000",
      resolver: SyntheticOrderReferenceResolver.fromOrdersCsv(ordersContent)
    });
    assert.equal(result.fileStatus, "validated");
    assert.equal(result.rowResults[0]?.parsed?.event_date, "2026-07-21");
    assert.equal(result.rowResults[0]?.parsed?.declared_weight_grams, 500);
    assert.equal(result.rowResults[0]?.parsed?.charged_weight_grams, 1000);
    assert.equal(result.rowResults[1]?.parsed?.event_date, "2026-07-26");
    assert.equal(result.rowResults[1]?.parsed?.declared_weight_grams, 250);
  });

  it("resolves seller order refs to deterministic internal UUIDs only", async () => {
    const resolver = SyntheticOrderReferenceResolver.fromOrdersCsv(ordersContent);
    const first = await resolver.resolveShipmentRef({ externalRef: "#1001" });
    const again = await resolver.resolveShipmentRef({ externalRef: "#1001" });
    const blank = await resolver.resolveShipmentRef({ externalRef: "" });
    const mangled = await resolver.resolveShipmentRef({ externalRef: "#1039A" });

    assert.match(first?.shipmentId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(first?.shipmentId, again?.shipmentId);
    assert.equal(blank, null);
    assert.equal(mangled, null);
  });

  it("previews synthetic seed without DB mutation", async () => {
    const { service, state } = makeSeedHarness();
    const result = await service.seed({
      misContent,
      ordersContent,
      manifestContent,
      misStoragePath: misPath,
      requestedBy: "import_pipeline_w0"
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.mutationPerformed, false);
    assert.equal(state.packs.length, 0);
    assert.equal(state.versions.length, 0);
    assert.equal(state.fixtures.length, 0);
    assert.equal(state.runs.length, 0);
  });

  it("executes seed through fixture gate and activates one synthetic pack", async () => {
    const { service, state } = makeSeedHarness();
    state.packs.push({
      id: "pack_prior",
      packKey: SYNTHETIC_BIGSHIP_PACK_KEY,
      source: SYNTHETIC_BIGSHIP_SOURCE,
      courierCode: SYNTHETIC_BIGSHIP_COUNTERPARTY
    });
    state.versions.push({
      id: "version_prior",
      packId: "pack_prior",
      version: "synthetic-2026-06-v1",
      definition: syntheticBigshipFormatPackDefinition(),
      definitionHash: "prior",
      minEngineVersion: "w0.synthetic.1",
      status: "active",
      createdBy: "usr_prior_checker",
      approvedBy: "usr_prior_checker",
      activatedAt: new Date(),
      retiredAt: null,
      createdAt: new Date("2026-07-01T00:00:00.000Z")
    });

    const result = await service.seed({
      misContent,
      ordersContent,
      manifestContent,
      misStoragePath: misPath,
      requestedBy: "import_pipeline_w0",
      approvedBy: "usr_w0_synthetic_checker",
      execute: true
    });

    assert.equal(result.dryRun, false);
    assert.equal((result as any).fixtureStatus, "passed");
    assert.equal(state.packs.length, 1);
    assert.equal(state.fixtures.length, 1);
    assert.equal(state.runs[0]?.status, "passed");
    const active = state.versions.filter((version) => version.status === "active");
    assert.equal(active.length, 1);
    assert.equal(active[0]?.version, SYNTHETIC_BIGSHIP_VERSION);
    assert.equal(state.versions.find((version) => version.id === "version_prior")?.status, "retired");
    assert.equal(state.importFiles.length, 0);
    assert.equal(state.stagingRows.length, 0);
    assert.equal(state.journalEntries.length, 0);
  });

  it("runs import dry-run through the active synthetic pack with order resolver", async () => {
    const { client, state } = makeSeedHarness();
    const definition = syntheticBigshipFormatPackDefinition();
    const definitionHash = formatPackDefinitionValidator.validate(definition).definitionHash;
    state.packs.push({
      id: "pack_1",
      packKey: SYNTHETIC_BIGSHIP_PACK_KEY,
      source: SYNTHETIC_BIGSHIP_SOURCE,
      courierCode: SYNTHETIC_BIGSHIP_COUNTERPARTY
    });
    state.versions.push({
      id: "version_1",
      packId: "pack_1",
      version: SYNTHETIC_BIGSHIP_VERSION,
      definition,
      definitionHash,
      minEngineVersion: "w0.synthetic.1",
      status: "active",
      createdBy: "import_pipeline_w0",
      approvedBy: "usr_w0_synthetic_checker",
      activatedAt: new Date("2026-07-04T00:00:00.000Z"),
      retiredAt: null,
      createdAt: new Date("2026-07-04T00:00:00.000Z")
    });

    const parser = new FormatPackParserService(client as any, new StagingRowService({} as any));
    const service = new PilotOpsService({ client: client as any, parser });
    const result = await service.runImportDryRun({
      csvContent: misContent,
      ordersCsvContent: ordersContent,
      source: SYNTHETIC_BIGSHIP_SOURCE,
      counterparty: SYNTHETIC_BIGSHIP_COUNTERPARTY,
      brandOrgId: "00000000-0000-4000-8000-000000000001",
      period: "2026-07",
      statedTotalMinor: "667470",
      createdBy: "import_pipeline_w0"
    });

    assert.equal(result.rowCount, 70);
    assert.equal(result.parsedCount, 66);
    assert.equal(result.resolvedCount, 66);
    assert.equal(result.exceptionCount, 4);
    assert.equal(result.exceptionRowCount, 4);
    assert.equal(result.fileExceptionCount, 0);
    assert.equal(result.fileStatus, "exception");
    assert.equal(result.fileExceptionCode, null);
    assert.equal(result.fileTies, true);
    assert.equal(result.rawFileTotalMinor, "667470");
    assert.equal(result.allRowsTotalMinor, "667470");
    assert.equal(result.postableTotalMinor, "636020");
    assert.equal(result.statedTotalMinor, "667470");
    assert.equal(result.blockingIssues.includes("IMPORT_TOTAL_MISMATCH"), false);
    assert.equal(result.blockingIssues.includes("IMPORT_ROW_EXCEPTIONS_PRESENT"), true);
    assert.equal(result.exceptionCodes.includes("UNKNOWN_CHARGE_CODE"), true);
    assert.equal(result.exceptionCodes.includes("UNRESOLVED_SHIPMENT"), true);
    assert.equal(result.eventClassCounts.freight_charged, 59);
    assert.equal(result.eventClassCounts.weight_dispute_debit, 4);
    assert.equal(result.eventClassCounts.weight_dispute_credit, 1);
    assert.equal(result.eventClassCounts.rto_freight_charged, 2);
    assert.equal(state.importFiles.length, 0);
    assert.equal(state.stagingRows.length, 0);
    assert.equal(state.journalEntries.length, 0);
  });

  it("enforces maker-checker principals for execute", async () => {
    const { service } = makeSeedHarness();
    await assert.rejects(
      () => service.seed({ misContent, ordersContent, manifestContent, misStoragePath: misPath, requestedBy: "bad@example.invalid", execute: true }),
      (error) => error instanceof ImportPipelineError && error.code === "W0_PILOT_INTERNAL_PRINCIPAL_INVALID"
    );
    await assert.rejects(
      () => service.seed({ misContent, ordersContent, manifestContent, misStoragePath: misPath, requestedBy: "import_pipeline_w0", approvedBy: "import_pipeline_w0", execute: true }),
      (error) => error instanceof ImportPipelineError && error.code === "PRINCIPAL_NOT_DISTINCT"
    );
  });

  it("keeps the no-tie generator variant available for tie-gate testing", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "w0-synthetic-notie-"));
    const output = execFileSync("node", [
      "fixtures/pilot/synthetic/generate-courier-fixture.mjs",
      "--out",
      outputDir,
      "--no-tie"
    ], { cwd: process.cwd(), encoding: "utf8" });
    try {
      assert.match(output, /ties=false/);
      const manifest = JSON.parse(readFileSync(join(outputDir, "traps-manifest.json"), "utf8"));
      assert.equal(manifest.misDataRows, 70);
      assert.equal(manifest.computedTotalMinor, 667470);
      assert.equal(manifest.statedTotalMinor, 682470);
      assert.equal(manifest.ties, false);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("marks only the generated no-tie fixture as an import total mismatch", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "w0-synthetic-notie-"));
    execFileSync("node", [
      "fixtures/pilot/synthetic/generate-courier-fixture.mjs",
      "--out",
      outputDir,
      "--no-tie"
    ], { cwd: process.cwd(), encoding: "utf8" });
    try {
      const generatedMis = readFileSync(join(outputDir, "bigship-mis-2026-07.csv"), "utf8");
      const generatedOrders = readFileSync(join(outputDir, "shopify-orders-2026-07.csv"), "utf8");
      const generatedManifest = JSON.parse(readFileSync(join(outputDir, "traps-manifest.json"), "utf8"));
      const { client, state } = makeSeedHarness();
      const definition = syntheticBigshipFormatPackDefinition();
      state.packs.push({
        id: "pack_1",
        packKey: SYNTHETIC_BIGSHIP_PACK_KEY,
        source: SYNTHETIC_BIGSHIP_SOURCE,
        courierCode: SYNTHETIC_BIGSHIP_COUNTERPARTY
      });
      state.versions.push({
        id: "version_1",
        packId: "pack_1",
        version: SYNTHETIC_BIGSHIP_VERSION,
        definition,
        definitionHash: formatPackDefinitionValidator.validate(definition).definitionHash,
        minEngineVersion: "w0.synthetic.1",
        status: "active",
        createdBy: "import_pipeline_w0",
        approvedBy: "usr_w0_synthetic_checker",
        activatedAt: new Date("2026-07-04T00:00:00.000Z"),
        retiredAt: null,
        createdAt: new Date("2026-07-04T00:00:00.000Z")
      });

      const parser = new FormatPackParserService(client as any, new StagingRowService({} as any));
      const service = new PilotOpsService({ client: client as any, parser });
      const result = await service.runImportDryRun({
        csvContent: generatedMis,
        ordersCsvContent: generatedOrders,
        source: SYNTHETIC_BIGSHIP_SOURCE,
        counterparty: SYNTHETIC_BIGSHIP_COUNTERPARTY,
        brandOrgId: "00000000-0000-4000-8000-000000000001",
        period: "2026-07",
        statedTotalMinor: String(generatedManifest.statedTotalMinor),
        createdBy: "import_pipeline_w0"
      });

      assert.equal(result.rawFileTotalMinor, "667470");
      assert.equal(result.allRowsTotalMinor, "667470");
      assert.equal(result.statedTotalMinor, "682470");
      assert.equal(result.fileTies, false);
      assert.equal(result.fileExceptionCode, "TOTAL_MISMATCH");
      assert.equal(result.blockingIssues.includes("IMPORT_TOTAL_MISMATCH"), true);
      assert.equal(result.shippable, false);
      assert.equal(result.exceptionCodes.includes("UNKNOWN_CHARGE_CODE"), true);
      assert.equal(result.exceptionCodes.includes("UNRESOLVED_SHIPMENT"), true);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

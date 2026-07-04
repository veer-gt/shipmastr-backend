import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { InMemoryFixtureContentProvider } from "./fixture-content-provider.js";
import { FormatPackActivationService } from "./format-pack-activation.service.js";
import { FormatPackFixtureRunner } from "./format-pack-fixture-runner.service.js";
import { FormatPackFixtureService, FormatPackFixtureServiceError } from "./format-pack-fixture.service.js";
import { validFormatPackDefinition } from "./format-pack-definition.fixture.js";
import { FormatPackParserService } from "./format-pack-parser.service.js";
import { ImportPipelineError } from "./import-pipeline.errors.js";

const baseTime = new Date("2026-07-04T14:00:00.000Z");

function csv(lines: string[]) {
  return lines.join("\n");
}

function validExpected(overrides: Record<string, unknown> = {}) {
  return {
    row_count: 1,
    parsed_count: 1,
    exception_count: 0,
    stated_total_minor: "11800",
    parsed_total_minor: "11800",
    event_class_counts: {
      freight_charged: 1,
      rto_freight_charged: 0
    },
    ...overrides
  };
}

function makeHarness() {
  const state = {
    packs: [{
      id: "pack_1",
      packKey: "bigship-courier-mis",
      source: "courier_mis",
      courierCode: "bigship",
      createdAt: baseTime
    }] as any[],
    versions: [] as any[],
    fixtures: [] as any[],
    runs: [] as any[],
    imports: [] as any[],
    stagedRows: [] as any[],
    entryRows: [] as any[],
    postingRows: [] as any[],
    holds: [] as any[],
    balances: [] as any[],
    outboxRows: [] as any[],
    transactions: 0
  };

  function withPack(record: any) {
    return record ? { ...record, pack: state.packs.find((pack) => pack.id === record.packId) } : null;
  }

  function versionMatches(version: any, where: any) {
    if (where.id && version.id !== where.id) return false;
    if (where.packVersionId && version.id !== where.packVersionId) return false;
    if (where.packId && version.packId !== where.packId) return false;
    if (where.status && version.status !== where.status) return false;
    if (where.pack?.packKey) {
      const pack = state.packs.find((item) => item.id === version.packId);
      if (pack?.packKey !== where.pack.packKey) return false;
    }
    return true;
  }

  function sortRecords(records: any[], orderBy: any) {
    const order = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...records].sort((left, right) => {
      for (const rule of order) {
        const [key, direction] = Object.entries(rule)[0] ?? [];
        if (!key) continue;
        const leftValue = left[key] instanceof Date ? left[key].getTime() : String(left[key] ?? "");
        const rightValue = right[key] instanceof Date ? right[key].getTime() : String(right[key] ?? "");
        if (leftValue === rightValue) continue;
        const result = leftValue > rightValue ? 1 : -1;
        return direction === "desc" ? -result : result;
      }
      return String(left.id).localeCompare(String(right.id));
    });
  }

  function addVersion(input: Partial<any> = {}) {
    const version = {
      id: input.id ?? `version_${state.versions.length + 1}`,
      packId: input.packId ?? "pack_1",
      version: input.version ?? `v${state.versions.length + 1}`,
      definition: input.definition ?? validFormatPackDefinition(),
      definitionHash: input.definitionHash ?? `hash_${state.versions.length + 1}`,
      minEngineVersion: "w0b2",
      status: input.status ?? "draft",
      createdBy: input.createdBy ?? "maker",
      approvedBy: input.approvedBy ?? null,
      activatedAt: input.activatedAt ?? null,
      retiredAt: input.retiredAt ?? null,
      createdAt: new Date(baseTime.getTime() + state.versions.length)
    };
    state.versions.push(version);
    return version;
  }

  const client: any = {
    $transaction: async (callback: any) => {
      state.transactions += 1;
      return callback(client);
    },
    formatPackVersion: {
      findUnique: async ({ where, include }: any) => {
        const version = state.versions.find((item) => item.id === where.id) ?? null;
        return include?.pack ? withPack(version) : version;
      },
      findFirst: async ({ where, include, orderBy }: any) => {
        const version = sortRecords(state.versions.filter((item) => versionMatches(item, where)), orderBy)[0] ?? null;
        return include?.pack ? withPack(version) : version;
      },
      findMany: async ({ where, include, orderBy }: any) => sortRecords(
        state.versions.filter((item) => versionMatches(item, where)),
        orderBy
      ).map((version) => include?.pack ? withPack(version) : version),
      update: async ({ where, data, include }: any) => {
        const version = state.versions.find((item) => item.id === where.id);
        if (!version) throw new Error("VERSION_NOT_FOUND");
        Object.assign(version, data);
        return include?.pack ? withPack(version) : version;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const version of state.versions) {
          if (versionMatches(version, where)) {
            Object.assign(version, data);
            count += 1;
          }
        }
        return { count };
      }
    },
    formatPackFixture: {
      create: async ({ data }: any) => {
        const fixture = {
          id: `fixture_${state.fixtures.length + 1}`,
          createdAt: new Date(baseTime.getTime() + state.fixtures.length),
          ...data
        };
        state.fixtures.push(fixture);
        return fixture;
      },
      findUnique: async ({ where, include }: any) => {
        const fixture = state.fixtures.find((item) => item.id === where.id) ?? null;
        if (!fixture) return null;
        return include?.packVersion
          ? { ...fixture, packVersion: state.versions.find((version) => version.id === fixture.packVersionId) }
          : fixture;
      },
      findMany: async ({ where, orderBy, take }: any) => {
        const records = sortRecords(
          state.fixtures.filter((fixture) => !where.packVersionId || fixture.packVersionId === where.packVersionId),
          orderBy
        );
        return typeof take === "number" ? records.slice(0, take) : records;
      },
      delete: async ({ where }: any) => {
        const index = state.fixtures.findIndex((fixture) => fixture.id === where.id);
        const [removed] = state.fixtures.splice(index, 1);
        return removed;
      }
    },
    formatPackTestRun: {
      create: async ({ data }: any) => {
        const run = {
          id: `run_${state.runs.length + 1}`,
          createdAt: new Date(baseTime.getTime() + state.runs.length),
          ...data
        };
        state.runs.push(run);
        return run;
      },
      findFirst: async ({ where, orderBy }: any) => sortRecords(
        state.runs.filter((run) => !where.packVersionId || run.packVersionId === where.packVersionId),
        orderBy
      )[0] ?? null
    }
  };

  function services(files: Record<string, string> = {}) {
    const parser = new FormatPackParserService(client);
    return {
      fixtureService: new FormatPackFixtureService(client),
      runner: new FormatPackFixtureRunner(new InMemoryFixtureContentProvider(files), client, parser),
      activation: new FormatPackActivationService(client)
    };
  }

  return { state, client, addVersion, services };
}

describe("W0B-4 format-pack fixtures and activation", () => {
  it("creates fixtures with normalized expected summaries and lists them deterministically", async () => {
    const { addVersion, services } = makeHarness();
    const version = addVersion();
    const { fixtureService } = services();

    await fixtureService.createFixture({
      packVersionId: version.id,
      fixtureName: "z-last",
      storagePath: "fixtures/z.csv",
      expectedSummary: validExpected()
    });
    await fixtureService.createFixture({
      packVersionId: version.id,
      fixtureName: "a-first",
      storagePath: "fixtures/a.csv",
      expectedSummary: validExpected({ event_class_counts: { freight_charged: 1 } })
    });

    const fixtures = await fixtureService.listFixtures(version.id);
    assert.deepEqual(fixtures.map((fixture) => fixture.fixtureName), ["a-first", "z-last"]);
    assert.deepEqual(fixtures[0]?.expectedSummary, validExpected({ event_class_counts: { freight_charged: 1 } }));
  });

  it("rejects invalid fixture expected summaries", async () => {
    const { addVersion, services } = makeHarness();
    const version = addVersion();
    const { fixtureService } = services();

    await assert.rejects(
      () => fixtureService.createFixture({
        packVersionId: version.id,
        fixtureName: "bad",
        storagePath: "fixtures/bad.csv",
        expectedSummary: { row_count: "1" }
      }),
      (error) => error instanceof FormatPackFixtureServiceError && error.code === "EXPECTED_SUMMARY_ROW_COUNT_INVALID"
    );
  });

  it("runs passing fixtures through dry-run parser and records a passed test run", async () => {
    const { addVersion, services, state } = makeHarness();
    const version = addVersion();
    const { fixtureService, runner } = services({
      "fixtures/good.csv": csv([
        "AWB,Charge Code,Amount,Date",
        "opaque-ref-1,FWD,118,04/07/2026"
      ])
    });
    await fixtureService.createFixture({
      packVersionId: version.id,
      fixtureName: "good",
      storagePath: "fixtures/good.csv",
      expectedSummary: validExpected()
    });

    const result = await runner.runFixtures({
      packVersionId: version.id,
      runnerVersion: "w0b4-test",
      createdBy: "qa"
    });

    assert.equal(result.status, "passed");
    assert.equal(state.runs[0]?.status, "passed");
    assert.equal(state.imports.length, 0);
    assert.equal(state.stagedRows.length, 0);
    assert.equal(state.entryRows.length, 0);
    assert.equal(state.postingRows.length, 0);
  });

  it("fails fixture runs for row count, parsed total, and event count mismatches", async () => {
    for (const expected of [
      validExpected({ row_count: 2 }),
      validExpected({ parsed_total_minor: "999" }),
      validExpected({ event_class_counts: { freight_charged: 0, rto_freight_charged: 0 } })
    ]) {
      const { addVersion, services, state } = makeHarness();
      const version = addVersion();
      const { fixtureService, runner } = services({
        "fixtures/mismatch.csv": csv([
          "AWB,Charge Code,Amount,Date",
          "opaque-ref-1,FWD,118,04/07/2026"
        ])
      });
      await fixtureService.createFixture({
        packVersionId: version.id,
        fixtureName: "mismatch",
        storagePath: "fixtures/mismatch.csv",
        expectedSummary: expected
      });

      const result = await runner.runFixtures({ packVersionId: version.id, runnerVersion: "w0b4-test", createdBy: "qa" });
      assert.equal(result.status, "failed");
      assert.equal(state.runs[0]?.status, "failed");
      assert.ok((state.runs[0]?.result.fixtures[0]?.summaryDiffs ?? []).length > 0);
    }
  });

  it("fails when no fixtures exist and records the failure", async () => {
    const { addVersion, services, state } = makeHarness();
    const version = addVersion();
    const { runner } = services();

    const result = await runner.runFixtures({ packVersionId: version.id, runnerVersion: "w0b4-test", createdBy: "qa" });

    assert.equal(result.status, "failed");
    assert.equal(state.runs[0]?.status, "failed");
    assert.equal(state.runs[0]?.result.failures[0]?.code, "FORMAT_PACK_FIXTURES_REQUIRED");
  });

  it("passes unknown charge-code fixtures when the expected exception summary matches", async () => {
    const { addVersion, services } = makeHarness();
    const version = addVersion();
    const { fixtureService, runner } = services({
      "fixtures/unknown-code.csv": csv([
        "AWB,Charge Code,Amount,Date",
        "opaque-ref-1,NEWCODE,118,04/07/2026"
      ])
    });
    await fixtureService.createFixture({
      packVersionId: version.id,
      fixtureName: "unknown-code",
      storagePath: "fixtures/unknown-code.csv",
      expectedSummary: validExpected({
        parsed_count: 0,
        exception_count: 1,
        stated_total_minor: "11800",
        parsed_total_minor: "0",
        raw_file_total_minor: "11800",
        postable_total_minor: "0",
        file_ties: true,
        exception_row_count: 1,
        postable_row_count: 0,
        event_class_counts: {}
      })
    });

    const result = await runner.runFixtures({ packVersionId: version.id, runnerVersion: "w0b4-test", createdBy: "qa" });

    assert.equal(result.status, "passed");
  });

  it("validates draft versions only after a latest passed fixture run", async () => {
    const { addVersion, services, state } = makeHarness();
    const version = addVersion();
    const { fixtureService, activation } = services();

    await assert.rejects(
      () => activation.validateVersion({ packVersionId: version.id, requestedBy: "ops" }),
      (error) => error instanceof ImportPipelineError && error.code === "FORMAT_PACK_FIXTURES_REQUIRED"
    );

    await fixtureService.createFixture({
      packVersionId: version.id,
      fixtureName: "good",
      storagePath: "fixtures/good.csv",
      expectedSummary: validExpected()
    });
    state.runs.push({ id: "run_failed", packVersionId: version.id, status: "failed", createdAt: new Date(baseTime.getTime() + 1) });
    await assert.rejects(
      () => activation.validateVersion({ packVersionId: version.id, requestedBy: "ops" }),
      (error) => error instanceof ImportPipelineError && error.code === "FORMAT_PACK_FIXTURE_RUN_NOT_PASSED"
    );

    state.runs.push({ id: "run_passed", packVersionId: version.id, status: "passed", createdAt: new Date(baseTime.getTime() + 2) });
    const validated = await activation.validateVersion({ packVersionId: version.id, requestedBy: "ops" });
    assert.equal(validated.status, "validated");

    await assert.rejects(
      () => activation.validateVersion({ packVersionId: version.id, requestedBy: "ops" }),
      (error) => error instanceof ImportPipelineError && error.code === "FORMAT_PACK_VALIDATE_STATUS_INVALID"
    );
  });

  it("marks canary only from validated and blocks direct draft or validated activation", async () => {
    const { addVersion, services } = makeHarness();
    const draft = addVersion({ id: "version_draft", status: "draft" });
    const validated = addVersion({ id: "version_validated", status: "validated" });
    const { activation } = services();

    await assert.rejects(
      () => activation.activateVersion({ packVersionId: draft.id, approvedBy: "checker" }),
      (error) => error instanceof ImportPipelineError && error.code === "FORMAT_PACK_ACTIVATE_STATUS_INVALID"
    );
    await assert.rejects(
      () => activation.activateVersion({ packVersionId: validated.id, approvedBy: "checker" }),
      (error) => error instanceof ImportPipelineError && error.code === "FORMAT_PACK_ACTIVATE_STATUS_INVALID"
    );

    const canary = await activation.markCanary({ packVersionId: validated.id, requestedBy: "ops" });
    assert.equal(canary.status, "canary");
    await assert.rejects(
      () => activation.markCanary({ packVersionId: draft.id, requestedBy: "ops" }),
      (error) => error instanceof ImportPipelineError && error.code === "FORMAT_PACK_CANARY_STATUS_INVALID"
    );
  });

  it("activates canary versions with maker-checker and retires the previous active pointer", async () => {
    const { addVersion, services, state } = makeHarness();
    const oldActive = addVersion({ id: "version_old", status: "active", createdBy: "maker_a", approvedBy: "checker_a", activatedAt: baseTime });
    const next = addVersion({ id: "version_next", status: "canary", createdBy: "maker_b" });
    const { activation } = services();

    await assert.rejects(
      () => activation.activateVersion({ packVersionId: next.id, approvedBy: "maker_b" }),
      (error) => error instanceof ImportPipelineError && error.code === "FORMAT_PACK_MAKER_CHECKER_REQUIRED"
    );

    state.transactions = 0;
    const activated = await activation.activateVersion({ packVersionId: next.id, approvedBy: "checker_b" });

    assert.equal(activated.status, "active");
    assert.equal(state.versions.find((version) => version.id === oldActive.id)?.status, "retired");
    assert.equal(state.versions.filter((version) => version.status === "active").length, 1);
    assert.equal(state.transactions, 1);
    const active = await activation.findActiveVersion("bigship-courier-mis");
    assert.equal(active?.id, next.id);
  });

  it("detects multiple active versions as a consistency error", async () => {
    const { addVersion, services } = makeHarness();
    addVersion({ id: "version_a", status: "active" });
    addVersion({ id: "version_b", status: "active" });
    const { activation } = services();

    await assert.rejects(
      () => activation.findActiveVersion("bigship-courier-mis"),
      (error) => error instanceof ImportPipelineError && error.code === "FORMAT_PACK_ACTIVE_CONSISTENCY_ERROR"
    );
  });

  it("rolls back by pointer switch without mutating definition JSON or hash", async () => {
    const { addVersion, services, state } = makeHarness();
    const priorDefinition = validFormatPackDefinition({ metadata: { revision: "prior" } });
    const prior = addVersion({
      id: "version_prior",
      status: "retired",
      createdBy: "maker_a",
      definition: priorDefinition,
      definitionHash: "prior_hash",
      retiredAt: baseTime
    });
    const current = addVersion({ id: "version_current", status: "active", createdBy: "maker_b", activatedAt: baseTime });
    const { activation } = services();

    await assert.rejects(
      () => activation.rollbackToVersion({ packVersionId: prior.id, approvedBy: "maker_a" }),
      (error) => error instanceof ImportPipelineError && error.code === "FORMAT_PACK_MAKER_CHECKER_REQUIRED"
    );

    const rolledBack = await activation.rollbackToVersion({ packVersionId: prior.id, approvedBy: "checker_a" });

    assert.equal(rolledBack.status, "active");
    assert.equal(state.versions.find((version) => version.id === current.id)?.status, "retired");
    assert.deepEqual(state.versions.find((version) => version.id === prior.id)?.definition, priorDefinition);
    assert.equal(state.versions.find((version) => version.id === prior.id)?.definitionHash, "prior_hash");
    assert.equal(state.versions.filter((version) => version.status === "active").length, 1);
  });

  it("completes the W0B lifecycle with drift activation and rollback without import side effects", async () => {
    const { addVersion, services, state } = makeHarness();
    const v1 = addVersion({ id: "version_lifecycle_v1", version: "v1", definitionHash: "hash_lifecycle_v1", createdBy: "maker_v1" });
    const v2Definition = validFormatPackDefinition({
      headers: {
        fingerprint: ["waybill", "billing head", "net amount", "invoice date"],
        aliases: {
          awb: ["waybill"],
          charge_code: ["billing head"],
          amount: ["net amount"],
          event_date: ["invoice date"]
        }
      },
      charge_code_map: {
        FWD: "freight_charged",
        RTO: "rto_freight_charged",
        RET: "return_freight_charged",
        WGT_DEBIT: "weight_dispute_debit",
        COD: "cod_collected",
        SURCHARGE: "deduction_unattributed"
      }
    });
    const v2 = addVersion({
      id: "version_lifecycle_v2",
      version: "v2",
      definition: v2Definition,
      definitionHash: "hash_lifecycle_v2",
      createdBy: "maker_v2"
    });
    const v1Hash = v1.definitionHash;
    const v2Hash = v2.definitionHash;
    const { fixtureService, runner, activation } = services({
      "fixtures/lifecycle-v1.csv": csv([
        "AWB,Charge Code,Amount,Date",
        "opaque-ref-1,FWD,118,04/07/2026"
      ]),
      "fixtures/lifecycle-v2.csv": csv([
        "Waybill,Billing Head,Net Amount,Invoice Date",
        "opaque-ref-2,SURCHARGE,50,2026-07-04"
      ])
    });

    await fixtureService.createFixture({
      packVersionId: v1.id,
      fixtureName: "lifecycle-v1",
      storagePath: "fixtures/lifecycle-v1.csv",
      expectedSummary: validExpected()
    });
    const v1Run = await runner.runFixtures({ packVersionId: v1.id, runnerVersion: "w0b-final", createdBy: "qa" });
    assert.equal(v1Run.status, "passed");
    await activation.validateVersion({ packVersionId: v1.id, requestedBy: "ops" });
    await activation.markCanary({ packVersionId: v1.id, requestedBy: "ops" });
    await activation.activateVersion({ packVersionId: v1.id, approvedBy: "checker_v1" });
    assert.equal((await activation.findActiveVersion("bigship-courier-mis"))?.id, v1.id);

    await fixtureService.createFixture({
      packVersionId: v2.id,
      fixtureName: "lifecycle-v2",
      storagePath: "fixtures/lifecycle-v2.csv",
      expectedSummary: validExpected({
        stated_total_minor: "5000",
        parsed_total_minor: "5000",
        event_class_counts: { deduction_unattributed: 1 }
      })
    });
    const v2Run = await runner.runFixtures({ packVersionId: v2.id, runnerVersion: "w0b-final", createdBy: "qa" });
    assert.equal(v2Run.status, "passed");
    await activation.validateVersion({ packVersionId: v2.id, requestedBy: "ops" });
    await activation.markCanary({ packVersionId: v2.id, requestedBy: "ops" });
    await activation.activateVersion({ packVersionId: v2.id, approvedBy: "checker_v2" });

    assert.equal(state.versions.find((version) => version.id === v1.id)?.status, "retired");
    assert.equal(state.versions.find((version) => version.id === v2.id)?.status, "active");
    assert.equal(state.versions.filter((version) => version.status === "active").length, 1);
    assert.equal((await activation.findActiveVersion("bigship-courier-mis"))?.id, v2.id);

    await activation.rollbackToVersion({ packVersionId: v1.id, approvedBy: "checker_rollback" });

    assert.equal(state.versions.find((version) => version.id === v1.id)?.status, "active");
    assert.equal(state.versions.find((version) => version.id === v2.id)?.status, "retired");
    assert.equal(state.versions.filter((version) => version.status === "active").length, 1);
    assert.equal((await activation.findActiveVersion("bigship-courier-mis"))?.id, v1.id);
    assert.equal(state.versions.find((version) => version.id === v1.id)?.definitionHash, v1Hash);
    assert.equal(state.versions.find((version) => version.id === v2.id)?.definitionHash, v2Hash);
    assert.equal(state.imports.length, 0);
    assert.equal(state.stagedRows.length, 0);
    assert.equal(state.entryRows.length, 0);
    assert.equal(state.postingRows.length, 0);
    assert.equal(state.holds.length, 0);
    assert.equal(state.balances.length, 0);
    assert.equal(state.outboxRows.length, 0);
    assert.equal(state.runs.filter((run) => run.status === "passed").length, 2);
    assert.equal(state.transactions, 3);
  });

  it("rejects deleting fixtures from active versions", async () => {
    const { addVersion, services, state } = makeHarness();
    const version = addVersion({ status: "active" });
    state.fixtures.push({
      id: "fixture_active",
      packVersionId: version.id,
      fixtureName: "active",
      storagePath: "fixtures/active.csv",
      expectedSummary: validExpected(),
      createdAt: baseTime
    });
    const { fixtureService } = services();

    await assert.rejects(
      () => fixtureService.deleteFixture("fixture_active"),
      (error) => error instanceof FormatPackFixtureServiceError && error.code === "FORMAT_PACK_FIXTURE_DELETE_LOCKED"
    );
  });

  it("keeps import pipeline source free of dynamic execution, money-float hazards, direct ledger writes, and public controllers", () => {
    const moduleDir = new URL(".", import.meta.url).pathname;
    const files = readdirSync(moduleDir).filter((file) => file.endsWith(".js") && !file.endsWith(".test.js"));
    const forbidden = [
      ["ev", "al("].join(""),
      ["new ", "Function"].join(""),
      ["v", "m."].join(""),
      ["child", "_process"].join(""),
      ["req", "uire("].join(""),
      ["imp", "ort("].join(""),
      ["parse", "Float"].join(""),
      ["Math", ".round"].join(""),
      ["Number", "("].join(""),
      ["journal", "Entry.create"].join(""),
      ["journal", "Posting.create"].join(""),
      ["account", "Balance.update"].join(""),
      ["wallet", "EventOutbox.create"].join(""),
      ["Router", "("].join("")
    ];

    for (const file of files) {
      const contents = readFileSync(join(moduleDir, file), "utf8");
      for (const marker of forbidden) {
        assert.equal(contents.includes(marker), false, `${file} contains forbidden marker`);
      }
    }
  });

  it("documents the partial unique active index migration", () => {
    const migration = readFileSync(
      join(new URL("../../..", import.meta.url).pathname, "prisma/migrations/20260704140000_w0b4_format_pack_activation/migration.sql"),
      "utf8"
    );
    assert.match(migration, /UNIQUE INDEX IF NOT EXISTS/);
    assert.match(migration, /WHERE "status" = 'active'/);
  });
});

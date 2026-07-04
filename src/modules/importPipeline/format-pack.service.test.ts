import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { FormatPackDefinitionValidationError } from "./format-pack-definition.validator.js";
import { validFormatPackDefinition } from "./format-pack-definition.fixture.js";
import { FormatPackService, FormatPackServiceError } from "./format-pack.service.js";
import type { FormatPackClient } from "./types.js";

const now = new Date("2026-07-04T13:00:00.000Z");

function uniqueConflict() {
  return Object.assign(new Error("unique conflict"), { code: "P2002" });
}

function makeFormatPackClient() {
  const state = {
    packs: [] as any[],
    versions: [] as any[],
    importFiles: [] as any[],
    stagingRows: [] as any[],
    journalEntries: [] as any[],
    journalPostings: [] as any[],
    walletHolds: [] as any[],
    accountBalances: [] as any[],
    walletEventsOutbox: [] as any[]
  };

  function packMatches(where: any, packId: string) {
    const pack = state.packs.find((item) => item.id === packId);
    return Boolean(pack && where?.pack?.packKey === pack.packKey);
  }

  const client: FormatPackClient = {
    formatPack: {
      create: async ({ data }) => {
        if (state.packs.some((pack) => pack.packKey === data.packKey)) throw uniqueConflict();
        const pack = {
          id: `pack_${state.packs.length + 1}`,
          createdAt: now,
          ...data
        };
        state.packs.push(pack);
        return pack as any;
      },
      findUnique: async ({ where }) => state.packs.find((pack) => pack.packKey === where.packKey) ?? null
    },
    formatPackVersion: {
      create: async ({ data, include }) => {
        if (state.versions.some((version) => version.packId === data.packId && version.version === data.version)) {
          throw uniqueConflict();
        }
        const version: any = {
          id: `version_${state.versions.length + 1}`,
          createdAt: new Date(now.getTime() + state.versions.length),
          approvedBy: null,
          activatedAt: null,
          retiredAt: null,
          ...data
        };
        state.versions.push(version);
        return include?.pack ? { ...version, pack: state.packs.find((pack) => pack.id === version.packId) } as any : version as any;
      },
      findFirst: async ({ where, include, orderBy }) => {
        const records = state.versions
          .filter((version) => (!where.version || version.version === where.version)
            && (!where.status || version.status === where.status)
            && (!where.pack || packMatches(where, version.packId)))
          .sort((a, b) => String(a.version).localeCompare(String(b.version)));
        if (Array.isArray(orderBy) && orderBy.some((item) => item.createdAt === "desc")) records.reverse();
        const record = records[0] ?? null;
        return record && include?.pack ? { ...record, pack: state.packs.find((pack) => pack.id === record.packId) } as any : record as any;
      },
      findMany: async ({ where, include }) => state.versions
        .filter((version) => (!where.pack || packMatches(where, version.packId)))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || String(a.version).localeCompare(String(b.version)))
        .map((version) => include?.pack ? { ...version, pack: state.packs.find((pack) => pack.id === version.packId) } as any : version as any)
    }
  };

  return { client, state };
}

describe("format pack service", () => {
  it("creates a format pack row", async () => {
    const { client, state } = makeFormatPackClient();
    const service = new FormatPackService(client);

    const pack = await service.createPack({
      packKey: "bigship-courier-mis",
      source: "courier_mis",
      courierCode: "bigship",
      description: "Courier MIS format pack"
    });

    assert.equal(pack.packKey, "bigship-courier-mis");
    assert.equal(state.packs.length, 1);
  });

  it("handles duplicate pack keys cleanly", async () => {
    const { client } = makeFormatPackClient();
    const service = new FormatPackService(client);

    await service.createPack({ packKey: "dup-pack", source: "courier_mis" });
    await assert.rejects(
      () => service.createPack({ packKey: "dup-pack", source: "courier_mis" }),
      (error) => error instanceof FormatPackServiceError && error.code === "FORMAT_PACK_KEY_CONFLICT"
    );
  });

  it("stores a valid draft version with deterministic definition hash", async () => {
    const { client, state } = makeFormatPackClient();
    const service = new FormatPackService(client);
    await service.createPack({ packKey: "bigship-courier-mis", source: "courier_mis" });

    const version = await service.createDraftVersion({
      packKey: "bigship-courier-mis",
      version: "2026-07-04",
      definition: validFormatPackDefinition(),
      minEngineVersion: "w0b2",
      createdBy: "ops_internal"
    });

    assert.equal(version.status, "draft");
    assert.equal(version.definitionHash.length, 64);
    assert.equal(state.versions[0]?.definitionHash, version.definitionHash);
    assert.equal(state.versions[0]?.minEngineVersion, "w0b2");
  });

  it("rejects invalid definitions before storing a draft version", async () => {
    const { client, state } = makeFormatPackClient();
    const service = new FormatPackService(client);
    await service.createPack({ packKey: "guarded-pack", source: "courier_mis" });

    await assert.rejects(
      () => service.createDraftVersion({
        packKey: "guarded-pack",
        version: "bad",
        definition: validFormatPackDefinition({ unknown_top: true }),
        minEngineVersion: "w0b2",
        createdBy: "ops_internal"
      }),
      FormatPackDefinitionValidationError
    );

    assert.equal(state.versions.length, 0);
  });

  it("lists versions in deterministic order and reads active versions only", async () => {
    const { client, state } = makeFormatPackClient();
    const service = new FormatPackService(client);
    await service.createPack({ packKey: "ordered-pack", source: "courier_mis" });
    await service.createDraftVersion({
      packKey: "ordered-pack",
      version: "v2",
      definition: validFormatPackDefinition(),
      minEngineVersion: "w0b2",
      createdBy: "ops_internal"
    });
    await service.createDraftVersion({
      packKey: "ordered-pack",
      version: "v1",
      definition: validFormatPackDefinition(),
      minEngineVersion: "w0b2",
      createdBy: "ops_internal"
    });
    state.versions[1].status = "active";

    const versions = await service.listVersions("ordered-pack");
    assert.deepEqual(versions.map((version) => version.version), ["v2", "v1"]);
    const active = await service.findActiveVersion("ordered-pack");
    assert.equal(active?.version, "v1");
    const fetched = await service.getVersion({ packKey: "ordered-pack", version: "v2" });
    assert.equal(fetched?.version, "v2");
  });

  it("does not create import rows or wallet ledger rows", async () => {
    const { client, state } = makeFormatPackClient();
    const service = new FormatPackService(client);
    await service.createPack({ packKey: "isolated-pack", source: "courier_mis" });
    await service.createDraftVersion({
      packKey: "isolated-pack",
      version: "draft",
      definition: validFormatPackDefinition(),
      minEngineVersion: "w0b2",
      createdBy: "ops_internal"
    });

    assert.equal(state.importFiles.length, 0);
    assert.equal(state.stagingRows.length, 0);
    assert.equal(state.journalEntries.length, 0);
    assert.equal(state.journalPostings.length, 0);
    assert.equal(state.walletHolds.length, 0);
    assert.equal(state.accountBalances.length, 0);
    assert.equal(state.walletEventsOutbox.length, 0);
  });

  it("does not directly write wallet ledger tables from import pipeline source", () => {
    const moduleDir = new URL(".", import.meta.url).pathname;
    const files = readdirSync(moduleDir).filter((file) => file.endsWith(".js"));
    const forbidden = [
      ["journal", "_entries"].join(""),
      ["journal", "_postings"].join(""),
      ["journal", "Entry.create"].join(""),
      ["journal", "Posting.create"].join(""),
      ["account", "Balance.update"].join(""),
      ["wallet", "EventOutbox.create"].join("")
    ];

    for (const file of files) {
      const contents = readFileSync(join(moduleDir, file), "utf8");
      for (const needle of forbidden) {
        assert.equal(contents.includes(needle), false, `${file} contains forbidden ledger marker`);
      }
    }
  });
});

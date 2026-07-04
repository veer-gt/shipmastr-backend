import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ImportFileService } from "./import-file.service.js";

function makeImportFileClient() {
  const state = {
    files: [] as any[]
  };

  const client = {
    importFile: {
      findUnique: async ({ where }: any) => state.files.find((file) => file.fileHash === where.fileHash || file.id === where.id) ?? null,
      create: async ({ data }: any) => {
        const file = {
          id: `import_${state.files.length + 1}`,
          createdAt: new Date("2026-07-04T13:00:00.000Z"),
          updatedAt: new Date("2026-07-04T13:00:00.000Z"),
          ...data
        };
        state.files.push(file);
        return file;
      },
      update: async ({ where, data }: any) => {
        const file = state.files.find((record) => record.id === where.id);
        Object.assign(file, data);
        return file;
      }
    }
  };

  return { client: client as any, state };
}

describe("W0B-3 import file landing", () => {
  it("lands files idempotently by file hash", async () => {
    const { client, state } = makeImportFileClient();
    const service = new ImportFileService(client);

    const first = await service.landFile({
      fileHash: "hash_1",
      source: "courier_mis",
      counterparty: "bigship",
      brandOrgId: "brand_1",
      period: "2026-07",
      storagePath: "quarantine/imports/hash_1.csv",
      statedTotalMinor: "11800"
    });
    const second = await service.landFile({
      fileHash: "hash_1",
      source: "courier_mis",
      storagePath: "ignored-second-path.csv"
    });

    assert.equal(first.id, second.id);
    assert.equal(state.files.length, 1);
    assert.equal(state.files[0]?.status, "landed");
    assert.equal(state.files[0]?.statedTotalMinor, 11800n);
  });

  it("marks parser lifecycle statuses", async () => {
    const { client } = makeImportFileClient();
    const service = new ImportFileService(client);
    const file = await service.landFile({
      fileHash: "hash_2",
      source: "courier_mis",
      storagePath: "quarantine/imports/hash_2.csv"
    });

    assert.equal((await service.markParsed(file.id)).status, "parsed");
    assert.equal((await service.markValidated(file.id)).status, "validated");
    assert.equal((await service.markStaged(file.id)).status, "staged");
    assert.equal((await service.markException(file.id)).status, "exception");
  });
});

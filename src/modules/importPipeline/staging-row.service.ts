import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { serializeParsedValue } from "./parser-primitives.js";

type StagingRowClient = {
  $transaction?<T>(callback: (tx: StagingRowClient) => Promise<T>): Promise<T>;
  stagingRow: {
    deleteMany(input: { where: { fileId: string } }): Promise<unknown>;
    createMany(input: { data: Array<Record<string, unknown>> }): Promise<unknown>;
  };
  importFile: {
    update(input: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
};

type PersistRowInput = {
  fileId: string;
  rowNo: number;
  raw: Record<string, unknown>;
  parsed?: Record<string, unknown> | null | undefined;
  eventClass?: string | null | undefined;
  shipmentId?: string | null | undefined;
  status: string;
  exceptionCode?: string | null | undefined;
  exceptionDetail?: Record<string, unknown> | null | undefined;
};

type PersistInput = {
  fileId: string;
  fileStatus: string;
  rows: PersistRowInput[];
};

const defaultClient = prisma as unknown as StagingRowClient;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(serializeParsedValue(value))) as Prisma.InputJsonValue;
}

export class StagingRowService {
  constructor(private readonly client: StagingRowClient = defaultClient) {}

  async replaceRows(input: PersistInput) {
    const run = async (tx: StagingRowClient) => {
      await tx.stagingRow.deleteMany({ where: { fileId: input.fileId } });
      if (input.rows.length) {
        await tx.stagingRow.createMany({
          data: input.rows.map((row) => ({
            fileId: input.fileId,
            rowNo: row.rowNo,
            raw: json(row.raw),
            parsed: row.parsed ? json(row.parsed) : Prisma.JsonNull,
            eventClass: row.eventClass ?? null,
            shipmentId: row.shipmentId ?? null,
            status: row.status,
            exceptionCode: row.exceptionCode ?? null,
            exceptionDetail: row.exceptionDetail ? json(row.exceptionDetail) : Prisma.JsonNull,
            postedEntryRef: null
          }))
        });
      }
      await tx.importFile.update({
        where: { id: input.fileId },
        data: { status: input.fileStatus }
      });
    };

    if (this.client.$transaction) return this.client.$transaction(run);
    return run(this.client);
  }
}

export const stagingRowService = new StagingRowService();

import { prisma } from "../../lib/prisma.js";
import { ImportPipelineError } from "./import-pipeline.errors.js";
import type { FormatPackVersionRecord } from "./types.js";

type ActivationVersionRecord = FormatPackVersionRecord & {
  approvedBy?: string | null;
  activatedAt?: Date | null;
  retiredAt?: Date | null;
};

type ActivationClient = {
  $transaction?<T>(callback: (tx: ActivationClient) => Promise<T>): Promise<T>;
  formatPackFixture: {
    findMany(input: { where: Record<string, unknown>; take?: number }): Promise<Array<Record<string, unknown>>>;
  };
  formatPackTestRun: {
    findFirst(input: {
      where: Record<string, unknown>;
      orderBy?: Array<Record<string, string>> | Record<string, string>;
    }): Promise<{ id: string; status: string; createdAt?: Date } | null>;
  };
  formatPackVersion: {
    findUnique(input: { where: { id: string }; include?: Record<string, unknown> }): Promise<ActivationVersionRecord | null>;
    findMany(input: {
      where: Record<string, unknown>;
      include?: Record<string, unknown>;
      orderBy?: Array<Record<string, string>> | Record<string, string>;
    }): Promise<ActivationVersionRecord[]>;
    update(input: {
      where: { id: string };
      data: Record<string, unknown>;
      include?: Record<string, unknown>;
    }): Promise<ActivationVersionRecord>;
    updateMany(input: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
  };
};

type ActorInput = {
  packVersionId: string;
  requestedBy?: string | undefined;
  approvedBy?: string | undefined;
};

const defaultClient = prisma as unknown as ActivationClient;

function cleanRequired(value: unknown, code: string, max = 160) {
  const text = String(value ?? "").trim();
  if (!text) throw new ImportPipelineError(code);
  return text.slice(0, max);
}

function actor(input: ActorInput, key: "requestedBy" | "approvedBy") {
  return cleanRequired(input[key], key === "approvedBy" ? "FORMAT_PACK_APPROVED_BY_REQUIRED" : "FORMAT_PACK_REQUESTED_BY_REQUIRED");
}

function now() {
  return new Date();
}

export class FormatPackActivationService {
  constructor(private readonly client: ActivationClient = defaultClient) {}

  async validateVersion(input: ActorInput) {
    const packVersionId = cleanRequired(input.packVersionId, "FORMAT_PACK_VERSION_ID_REQUIRED");
    actor(input, "requestedBy");
    const version = await this.loadVersion(packVersionId);
    if (version.status !== "draft") throw new ImportPipelineError("FORMAT_PACK_VALIDATE_STATUS_INVALID", "FORMAT_PACK_VALIDATE_STATUS_INVALID", { status: version.status });

    const fixtures = await this.client.formatPackFixture.findMany({ where: { packVersionId }, take: 1 });
    if (!fixtures.length) throw new ImportPipelineError("FORMAT_PACK_FIXTURES_REQUIRED");

    const latestRun = await this.client.formatPackTestRun.findFirst({
      where: { packVersionId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });
    if (!latestRun) throw new ImportPipelineError("FORMAT_PACK_FIXTURE_RUN_REQUIRED");
    if (latestRun.status !== "passed") throw new ImportPipelineError("FORMAT_PACK_FIXTURE_RUN_NOT_PASSED", "FORMAT_PACK_FIXTURE_RUN_NOT_PASSED", { status: latestRun.status });

    return this.client.formatPackVersion.update({
      where: { id: packVersionId },
      data: { status: "validated" },
      include: { pack: true }
    });
  }

  async markCanary(input: ActorInput) {
    const packVersionId = cleanRequired(input.packVersionId, "FORMAT_PACK_VERSION_ID_REQUIRED");
    actor(input, "requestedBy");
    const version = await this.loadVersion(packVersionId);
    if (version.status !== "validated") throw new ImportPipelineError("FORMAT_PACK_CANARY_STATUS_INVALID", "FORMAT_PACK_CANARY_STATUS_INVALID", { status: version.status });
    return this.client.formatPackVersion.update({
      where: { id: packVersionId },
      data: { status: "canary" },
      include: { pack: true }
    });
  }

  async activateVersion(input: ActorInput) {
    const packVersionId = cleanRequired(input.packVersionId, "FORMAT_PACK_VERSION_ID_REQUIRED");
    const approvedBy = actor(input, "approvedBy");
    return this.withTransaction(async (tx) => {
      const version = await this.loadVersion(packVersionId, tx);
      if (version.status !== "canary") throw new ImportPipelineError("FORMAT_PACK_ACTIVATE_STATUS_INVALID", "FORMAT_PACK_ACTIVATE_STATUS_INVALID", { status: version.status });
      this.assertChecker(version, approvedBy);
      return this.activatePointer(tx, version, approvedBy);
    });
  }

  async rollbackToVersion(input: ActorInput) {
    const packVersionId = cleanRequired(input.packVersionId, "FORMAT_PACK_VERSION_ID_REQUIRED");
    const approvedBy = actor(input, "approvedBy");
    return this.withTransaction(async (tx) => {
      const version = await this.loadVersion(packVersionId, tx);
      if (!["retired", "validated", "canary"].includes(version.status)) {
        throw new ImportPipelineError("FORMAT_PACK_ROLLBACK_STATUS_INVALID", "FORMAT_PACK_ROLLBACK_STATUS_INVALID", { status: version.status });
      }
      this.assertChecker(version, approvedBy);
      return this.activatePointer(tx, version, approvedBy);
    });
  }

  async findActiveVersion(packKeyInput: string) {
    const packKey = cleanRequired(packKeyInput, "FORMAT_PACK_KEY_REQUIRED");
    const active = await this.client.formatPackVersion.findMany({
      where: { status: "active", pack: { packKey } },
      include: { pack: true },
      orderBy: [{ activatedAt: "desc" }, { createdAt: "desc" }, { version: "desc" }]
    });
    if (active.length > 1) throw new ImportPipelineError("FORMAT_PACK_ACTIVE_CONSISTENCY_ERROR", "FORMAT_PACK_ACTIVE_CONSISTENCY_ERROR", { packKey });
    return active[0] ?? null;
  }

  private async activatePointer(tx: ActivationClient, version: ActivationVersionRecord, approvedBy: string) {
    const activatedAt = now();
    await tx.formatPackVersion.updateMany({
      where: { packId: version.packId, status: "active" },
      data: { status: "retired", retiredAt: activatedAt }
    });
    const activated = await tx.formatPackVersion.update({
      where: { id: version.id },
      data: {
        status: "active",
        approvedBy,
        activatedAt,
        retiredAt: null
      },
      include: { pack: true }
    });
    const active = await tx.formatPackVersion.findMany({
      where: { packId: version.packId, status: "active" },
      include: { pack: true },
      orderBy: [{ activatedAt: "desc" }, { createdAt: "desc" }, { version: "desc" }]
    });
    if (active.length !== 1) {
      throw new ImportPipelineError("FORMAT_PACK_ACTIVE_CONSISTENCY_ERROR", "FORMAT_PACK_ACTIVE_CONSISTENCY_ERROR", { packId: version.packId });
    }
    return activated;
  }

  private assertChecker(version: ActivationVersionRecord, approvedBy: string) {
    if (version.createdBy === approvedBy) {
      throw new ImportPipelineError("FORMAT_PACK_MAKER_CHECKER_REQUIRED");
    }
  }

  private async loadVersion(packVersionId: string, client: ActivationClient = this.client) {
    const version = await client.formatPackVersion.findUnique({
      where: { id: packVersionId },
      include: { pack: true }
    });
    if (!version) throw new ImportPipelineError("FORMAT_PACK_VERSION_NOT_FOUND");
    return version;
  }

  private async withTransaction<T>(callback: (tx: ActivationClient) => Promise<T>) {
    if (this.client.$transaction) return this.client.$transaction(callback);
    return callback(this.client);
  }
}

export const formatPackActivationService = new FormatPackActivationService();

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import {
  formatPackDefinitionValidator,
  FormatPackDefinitionValidator
} from "./format-pack-definition.validator.js";
import type {
  FormatPackClient,
  FormatPackCreateInput,
  FormatPackDefinition,
  FormatPackDraftVersionInput,
  FormatPackVersionLookupInput
} from "./types.js";

const defaultClient = prisma as unknown as FormatPackClient;

export class FormatPackServiceError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "FormatPackServiceError";
    this.code = code;
  }
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
}

function cleanRequired(value: unknown, code: string, max = 160) {
  const text = String(value ?? "").trim();
  if (!text) throw new FormatPackServiceError(code);
  return text.slice(0, max);
}

function cleanOptional(value: unknown, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export class FormatPackService {
  constructor(
    private readonly client: FormatPackClient = defaultClient,
    private readonly validator: FormatPackDefinitionValidator = formatPackDefinitionValidator
  ) {}

  async createPack(input: FormatPackCreateInput) {
    try {
      return await this.client.formatPack.create({
        data: {
          packKey: cleanRequired(input.packKey, "FORMAT_PACK_KEY_REQUIRED"),
          source: cleanRequired(input.source, "FORMAT_PACK_SOURCE_REQUIRED"),
          courierCode: cleanOptional(input.courierCode, 80),
          description: cleanOptional(input.description)
        }
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new FormatPackServiceError("FORMAT_PACK_KEY_CONFLICT");
      }
      throw error;
    }
  }

  validateDefinition(definition: FormatPackDefinition) {
    return this.validator.validate(definition);
  }

  async createDraftVersion(input: FormatPackDraftVersionInput) {
    const packKey = cleanRequired(input.packKey, "FORMAT_PACK_KEY_REQUIRED");
    const pack = await this.client.formatPack.findUnique({ where: { packKey } });
    if (!pack) throw new FormatPackServiceError("FORMAT_PACK_NOT_FOUND");

    const validation = this.validateDefinition(input.definition);

    try {
      return await this.client.formatPackVersion.create({
        data: {
          packId: pack.id,
          version: cleanRequired(input.version, "FORMAT_PACK_VERSION_REQUIRED", 80),
          definition: json(input.definition),
          definitionHash: validation.definitionHash,
          minEngineVersion: cleanRequired(input.minEngineVersion, "FORMAT_PACK_ENGINE_VERSION_REQUIRED", 80),
          status: "draft",
          createdBy: cleanRequired(input.createdBy, "FORMAT_PACK_CREATED_BY_REQUIRED", 160)
        },
        include: { pack: true }
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new FormatPackServiceError("FORMAT_PACK_VERSION_CONFLICT");
      }
      throw error;
    }
  }

  async getVersion(input: FormatPackVersionLookupInput) {
    const packKey = cleanRequired(input.packKey, "FORMAT_PACK_KEY_REQUIRED");
    return this.client.formatPackVersion.findFirst({
      where: {
        version: cleanRequired(input.version, "FORMAT_PACK_VERSION_REQUIRED", 80),
        pack: { packKey }
      },
      include: { pack: true }
    });
  }

  async listVersions(packKeyInput: string) {
    const packKey = cleanRequired(packKeyInput, "FORMAT_PACK_KEY_REQUIRED");
    return this.client.formatPackVersion.findMany({
      where: { pack: { packKey } },
      include: { pack: true },
      orderBy: [{ createdAt: "asc" }, { version: "asc" }]
    });
  }

  async findActiveVersion(packKeyInput: string) {
    const packKey = cleanRequired(packKeyInput, "FORMAT_PACK_KEY_REQUIRED");
    return this.client.formatPackVersion.findFirst({
      where: {
        status: "active",
        pack: { packKey }
      },
      include: { pack: true },
      orderBy: [{ createdAt: "desc" }, { version: "desc" }]
    });
  }
}

export const formatPackService = new FormatPackService();

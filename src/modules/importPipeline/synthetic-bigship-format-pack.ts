import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { formatPackDefinitionValidator } from "./format-pack-definition.validator.js";
import { FormatPackFixtureRunner } from "./format-pack-fixture-runner.service.js";
import { FormatPackParserService } from "./format-pack-parser.service.js";
import { ImportPipelineError } from "./import-pipeline.errors.js";
import { type ShipmentReferenceResolver } from "./shipment-reference-resolver.js";
import type { FormatPackDefinition, FormatPackVersionRecord } from "./types.js";
import { FormatPackActivationService } from "./format-pack-activation.service.js";

export const SYNTHETIC_BIGSHIP_PACK_KEY = "bigship_synthetic_courier_mis";
export const SYNTHETIC_BIGSHIP_SOURCE = "courier_mis";
export const SYNTHETIC_BIGSHIP_COUNTERPARTY = "BIGSHIP_SYNTHETIC";
export const SYNTHETIC_BIGSHIP_VERSION = "synthetic-2026-07-v1";
export const SYNTHETIC_BIGSHIP_ENGINE_VERSION = "w0.synthetic.1";
export const SYNTHETIC_BIGSHIP_FIXTURE_NAME = "bigship-synthetic-2026-07";

type JsonRecord = Record<string, unknown>;

type SyntheticSeedClient = {
  $transaction?<T>(callback: (tx: SyntheticSeedClient) => Promise<T>): Promise<T>;
  formatPack: {
    create(input: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
    findUnique(input: { where: { packKey: string } }): Promise<Record<string, unknown> | null>;
  };
  formatPackVersion: {
    create(input: { data: Record<string, unknown>; include?: Record<string, unknown> }): Promise<FormatPackVersionRecord>;
    findFirst(input: Record<string, unknown>): Promise<FormatPackVersionRecord | null>;
  };
  formatPackFixture: {
    create(input: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
    findFirst(input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    update(input: { where: { id: string }; data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  };
};

type SyntheticPackPreviewInput = {
  misContent: string;
  ordersContent?: string | undefined;
  manifestContent?: string | undefined;
};

type SyntheticSeedInput = SyntheticPackPreviewInput & {
  misStoragePath: string;
  requestedBy?: string | undefined;
  approvedBy?: string | undefined;
  execute?: boolean | undefined;
};

type CsvRow = Record<string, string>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parseCsv(content: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char === "\r") {
      if (next === "\n") continue;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((value) => value !== "") || rows.length === 0) rows.push(row);
  return rows;
}

function csvObjects(content: string): CsvRow[] {
  const [headers = [], ...rows] = parseCsv(content);
  return rows
    .filter((row) => row.some((value) => String(value ?? "").trim()))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header.trim(), String(row[index] ?? "").trim()])));
}

function deterministicShipmentUuid(orderRef: string) {
  const hash = createHash("sha256").update(`w0.synthetic.order:${orderRef}`, "utf8").digest("hex").slice(0, 32).split("");
  hash[12] = "4";
  const variant = (8 + (parseInt(hash[16] ?? "0", 16) % 4)).toString(16);
  hash[16] = variant;
  const value = hash.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function manifestSummary(content?: string) {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) return null;
    return {
      misDataRows: parsed.misDataRows,
      misDuplicateRows: parsed.misDuplicateRows,
      misUniqueEconomicRows: parsed.misUniqueEconomicRows,
      computedTotalMinor: parsed.computedTotalMinor,
      statedTotalMinor: parsed.statedTotalMinor,
      ties: parsed.ties
    };
  } catch {
    return null;
  }
}

function cleanInternalPrincipal(value: unknown, code = "W0_PILOT_INTERNAL_PRINCIPAL_REQUIRED") {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ImportPipelineError(code, code);
  const clipped = text.slice(0, 160);
  if (clipped.includes("@")) throw new ImportPipelineError("W0_PILOT_INTERNAL_PRINCIPAL_INVALID", "W0_PILOT_INTERNAL_PRINCIPAL_INVALID");
  if (clipped === "import_pipeline_w0" || clipped.startsWith("system:") || clipped.startsWith("usr_")) return clipped;
  throw new ImportPipelineError("W0_PILOT_INTERNAL_PRINCIPAL_INVALID", "W0_PILOT_INTERNAL_PRINCIPAL_INVALID");
}

export class SyntheticOrderReferenceResolver implements ShipmentReferenceResolver {
  private constructor(private readonly shipmentIdsByOrderRef: Map<string, string>) {}

  static fromOrdersCsv(content?: string | undefined) {
    const map = new Map<string, string>();
    if (content) {
      for (const row of csvObjects(content)) {
        const name = String(row.Name ?? "").trim();
        if (/^#[0-9]+$/.test(name)) map.set(name, deterministicShipmentUuid(name));
      }
    }
    return new SyntheticOrderReferenceResolver(map);
  }

  async resolveShipmentRef(input: { externalRef: string }) {
    const orderRef = String(input.externalRef ?? "").trim();
    let shipmentId: string | undefined;
    for (const [candidate, candidateShipmentId] of this.shipmentIdsByOrderRef) {
      if (candidate === orderRef) {
        shipmentId = candidateShipmentId;
        break;
      }
    }
    return shipmentId ? { shipmentId } : null;
  }
}

export function syntheticBigshipFormatPackDefinition(): FormatPackDefinition {
  return {
    schema_version: "1",
    source: SYNTHETIC_BIGSHIP_SOURCE,
    headers: {
      fingerprint: ["AWB No", "Order Ref", "Charge Head", "Net Amount"],
      aliases: {
        external_awb: ["AWB No", "AWB", "Waybill", "Docket No", "Tracking Number"],
        external_order_ref: ["Order Ref", "Order", "Shopify Order", "Name"],
        charge_code: ["Charge Head", "Charge Code", "Billing Head", "Fee Type"],
        amount_minor: ["Net Amount", "Amount", "Net Charge"],
        event_date: ["Booking Date", "Billing Date", "Date"],
        declared_weight_grams: ["Declared Wt (Kg)", "Declared Weight"],
        charged_weight_grams: ["Charged Wt (Kg)", "Charged Weight"]
      }
    },
    columns: {
      external_awb: { from: "external_awb", transforms: ["trim"] },
      external_order_ref: { from: "external_order_ref", transforms: ["trim"] },
      charge_code: { from: "charge_code", transforms: ["trim", "normalize_whitespace"] },
      amount_minor: { from: "amount_minor", transforms: ["parse_paise"] },
      event_date: { from: "event_date", transforms: [{ parse_date: ["DD-MMM-YY", "DD/MM/YYYY", "YYYY-MM-DD"] }] },
      declared_weight_grams: { from: "declared_weight_grams", transforms: ["parse_grams"] },
      charged_weight_grams: { from: "charged_weight_grams", transforms: ["parse_grams"] }
    },
    charge_code_map: {
      FREIGHT: "freight_charged",
      "FREIGHT REBILL": "freight_charged",
      "RTO FREIGHT": "rto_freight_charged",
      "WT DISC DEBIT": "weight_dispute_debit",
      "WT DISC CREDIT": "weight_dispute_credit"
    },
    row_filters: [{ type: "subtotal_row" }],
    duplicate_key: ["external_awb", "charge_code", "amount_minor", "event_date"],
    total_rule: { field: "amount_minor", must_equal: "stated_total_minor" },
    metadata: {
      fixture_kind: "synthetic_sample",
      counterparty: SYNTHETIC_BIGSHIP_COUNTERPARTY,
      resolver_key: "external_order_ref",
      pii_quarantine: "raw_and_parsed_only"
    }
  };
}

function expectedSummary(parseResult: Awaited<ReturnType<FormatPackParserService["dryRunParseCsv"]>>) {
  return {
    row_count: parseResult.rowCount,
    parsed_count: parseResult.parsedCount,
    exception_count: parseResult.exceptionCount,
    stated_total_minor: parseResult.statedTotalMinor ?? null,
    parsed_total_minor: parseResult.parsedTotalMinor,
    raw_file_total_minor: parseResult.rawFileTotalMinor,
    all_rows_total_minor: parseResult.allRowsTotalMinor,
    postable_total_minor: parseResult.postableTotalMinor,
    file_ties: parseResult.fileTies,
    exception_row_count: parseResult.exceptionRowCount,
    postable_row_count: parseResult.postableRowCount,
    event_class_counts: parseResult.eventClassCounts
  };
}

export async function syntheticBigshipPackPreview(input: SyntheticPackPreviewInput) {
  const definition = syntheticBigshipFormatPackDefinition();
  const validation = formatPackDefinitionValidator.validate(definition);
  const parser = new FormatPackParserService({
    formatPackVersion: {
      findUnique: async () => ({
        id: "synthetic_preview_version",
        packId: "synthetic_preview_pack",
        version: SYNTHETIC_BIGSHIP_VERSION,
        definition,
        definitionHash: validation.definitionHash,
        minEngineVersion: SYNTHETIC_BIGSHIP_ENGINE_VERSION,
        status: "draft",
        createdBy: "import_pipeline_w0",
        pack: {
          id: "synthetic_preview_pack",
          packKey: SYNTHETIC_BIGSHIP_PACK_KEY,
          source: SYNTHETIC_BIGSHIP_SOURCE,
          courierCode: SYNTHETIC_BIGSHIP_COUNTERPARTY
        }
      }),
      findFirst: async () => null
    }
  } as never);
  const manifest = manifestSummary(input.manifestContent);
  const parsed = await parser.dryRunParseCsv({
    csvContent: input.misContent,
    formatPackVersionId: "synthetic_preview_version",
    statedTotalMinor: isRecord(manifest) && typeof manifest.statedTotalMinor !== "undefined" ? String(manifest.statedTotalMinor) : undefined,
    source: SYNTHETIC_BIGSHIP_SOURCE,
    counterparty: SYNTHETIC_BIGSHIP_COUNTERPARTY,
    resolver: SyntheticOrderReferenceResolver.fromOrdersCsv(input.ordersContent),
    persistStagingRows: false
  });
  return {
    identity: {
      packKey: SYNTHETIC_BIGSHIP_PACK_KEY,
      source: SYNTHETIC_BIGSHIP_SOURCE,
      counterparty: SYNTHETIC_BIGSHIP_COUNTERPARTY,
      version: SYNTHETIC_BIGSHIP_VERSION,
      minEngineVersion: SYNTHETIC_BIGSHIP_ENGINE_VERSION
    },
    definition,
    definitionHash: validation.definitionHash,
    expectedSummary: expectedSummary(parsed),
    parserPreview: {
      rowCount: parsed.rowCount,
      parsedCount: parsed.parsedCount,
      resolvedCount: parsed.resolvedCount,
      exceptionCount: parsed.exceptionCount,
      exceptionRowCount: parsed.exceptionRowCount,
      fileExceptionCount: parsed.fileExceptionCount,
      skippedCount: parsed.skippedCount,
      parsedTotalMinor: parsed.parsedTotalMinor,
      postableTotalMinor: parsed.postableTotalMinor,
      rawFileTotalMinor: parsed.rawFileTotalMinor,
      allRowsTotalMinor: parsed.allRowsTotalMinor,
      statedTotalMinor: parsed.statedTotalMinor ?? null,
      fileTies: parsed.fileTies,
      fileStatus: parsed.fileStatus,
      fileExceptionCode: parsed.fileExceptionCode ?? null,
      statusCounts: parsed.statusCounts,
      eventClassCounts: parsed.eventClassCounts,
      rowExceptionCodes: parsed.rowExceptionCodes,
      exceptionCodes: parsed.exceptionCodes
    },
    manifest,
    fixture: {
      fixtureName: SYNTHETIC_BIGSHIP_FIXTURE_NAME,
      storagePath: "fixtures/pilot/synthetic/bigship-mis-2026-07.csv"
    },
    intendedTransitions: ["create_or_find_pack", "create_or_find_draft_version", "attach_fixture", "run_fixture_gate", "validate", "canary", "activate"]
  };
}

export class SyntheticBigshipFormatPackSeedService {
  constructor(
    private readonly client: SyntheticSeedClient,
    private readonly fixtureRunner: FormatPackFixtureRunner,
    private readonly activation: FormatPackActivationService
  ) {}

  async seed(input: SyntheticSeedInput) {
    const requestedBy = cleanInternalPrincipal(input.requestedBy ?? "import_pipeline_w0", "FORMAT_PACK_REQUESTED_BY_REQUIRED");
    const execute = input.execute === true;
    const approvedBy = input.approvedBy ? cleanInternalPrincipal(input.approvedBy, "FORMAT_PACK_APPROVED_BY_REQUIRED") : null;
    if (execute && !approvedBy) throw new ImportPipelineError("FORMAT_PACK_APPROVED_BY_REQUIRED", "FORMAT_PACK_APPROVED_BY_REQUIRED");
    if (execute && approvedBy === requestedBy) throw new ImportPipelineError("PRINCIPAL_NOT_DISTINCT", "PRINCIPAL_NOT_DISTINCT");

    const preview = await syntheticBigshipPackPreview(input);
    if (!execute) {
      return {
        dryRun: true,
        mutationPerformed: false,
        ...preview,
        warnings: [{ code: "LOCAL_ONLY", message: "Synthetic format-pack seed is local/internal sample data only." }]
      };
    }

    const pack = await this.ensurePack();
    const version = await this.ensureDraftVersion(pack.id as string, requestedBy, preview.definition, preview.definitionHash);
    if (version.status === "active") {
      return {
        dryRun: false,
        mutationPerformed: false,
        ...preview,
        packId: pack.id,
        packVersionId: version.id,
        fixtureStatus: "already_active",
        executedTransitions: [],
        warnings: [{ code: "SYNTHETIC_FORMAT_PACK_ALREADY_ACTIVE", message: "Synthetic format pack version is already active." }]
      };
    }
    await this.attachFixture(version.id, input.misStoragePath, preview.expectedSummary);
    const fixtureRun = await this.fixtureRunner.runFixtures({
      packVersionId: version.id,
      runnerVersion: "w0d-h3",
      createdBy: requestedBy,
      resolver: SyntheticOrderReferenceResolver.fromOrdersCsv(input.ordersContent)
    });
    if (fixtureRun.status !== "passed") {
      throw new ImportPipelineError("SYNTHETIC_FIXTURE_GATE_FAILED", "SYNTHETIC_FIXTURE_GATE_FAILED", {
        packVersionId: version.id,
        fixtureRun: fixtureRun.result
      });
    }
    await this.activation.validateVersion({ packVersionId: version.id, requestedBy });
    await this.activation.markCanary({ packVersionId: version.id, requestedBy });
    const active = await this.activation.activateVersion({ packVersionId: version.id, approvedBy: approvedBy! });
    return {
      dryRun: false,
      mutationPerformed: true,
      ...preview,
      packId: pack.id,
      packVersionId: active.id,
      fixtureStatus: fixtureRun.status,
      executedTransitions: ["create_or_find_pack", "create_or_find_draft_version", "attach_fixture", "run_fixture_gate", "validate", "canary", "activate"],
      warnings: [{ code: "SYNTHETIC_SAMPLE_ONLY", message: "Synthetic fixture proves machinery only; real anonymized courier MIS remains required." }]
    };
  }

  private async ensurePack() {
    const existing = await this.client.formatPack.findUnique({ where: { packKey: SYNTHETIC_BIGSHIP_PACK_KEY } });
    if (existing) return existing;
    return this.client.formatPack.create({
      data: {
        packKey: SYNTHETIC_BIGSHIP_PACK_KEY,
        source: SYNTHETIC_BIGSHIP_SOURCE,
        courierCode: SYNTHETIC_BIGSHIP_COUNTERPARTY,
        description: "Local synthetic Bigship-like courier MIS SAMPLE format pack"
      }
    });
  }

  private async ensureDraftVersion(packId: string, createdBy: string, definition: FormatPackDefinition, definitionHash: string): Promise<FormatPackVersionRecord> {
    const existing = await this.client.formatPackVersion.findFirst({
      where: { packId, version: SYNTHETIC_BIGSHIP_VERSION },
      include: { pack: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });
    if (existing) {
      if (existing.status === "active") return existing;
      if (existing.status !== "draft") {
        throw new ImportPipelineError("SYNTHETIC_FORMAT_PACK_VERSION_LOCKED", "SYNTHETIC_FORMAT_PACK_VERSION_LOCKED", {
          status: existing.status
        });
      }
      return existing;
    }
    return this.client.formatPackVersion.create({
      data: {
        packId,
        version: SYNTHETIC_BIGSHIP_VERSION,
        definition: json(definition),
        definitionHash,
        minEngineVersion: SYNTHETIC_BIGSHIP_ENGINE_VERSION,
        status: "draft",
        createdBy
      },
      include: { pack: true }
    });
  }

  private async attachFixture(packVersionId: string, storagePath: string, summary: unknown) {
    const existing = await this.client.formatPackFixture.findFirst({
      where: { packVersionId, fixtureName: SYNTHETIC_BIGSHIP_FIXTURE_NAME },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });
    const data = {
      packVersionId,
      fixtureName: SYNTHETIC_BIGSHIP_FIXTURE_NAME,
      storagePath,
      expectedSummary: json(summary),
      expectedRowsPath: null
    };
    if (existing?.id && typeof existing.id === "string") {
      return this.client.formatPackFixture.update({ where: { id: existing.id }, data });
    }
    return this.client.formatPackFixture.create({ data });
  }
}

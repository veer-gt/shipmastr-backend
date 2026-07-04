import { prisma } from "../../lib/prisma.js";
import { ALLOWED_EVENT_CLASSES, formatPackDefinitionValidator } from "./format-pack-definition.validator.js";
import { ImportPipelineError, ImportPipelineRowError } from "./import-pipeline.errors.js";
import {
  applyPrimitive,
  classifyChargeCode,
  normalizeHeader,
  serializeParsedValue
} from "./parser-primitives.js";
import { NullShipmentReferenceResolver, type ShipmentReferenceResolver } from "./shipment-reference-resolver.js";
import { StagingRowService, stagingRowService } from "./staging-row.service.js";
import type { FormatPackDefinition, FormatPackVersionRecord } from "./types.js";

type ParserClient = {
  formatPackVersion: {
    findUnique?(input: { where: { id: string }; include?: Record<string, unknown> }): Promise<FormatPackVersionRecord | null>;
    findFirst(input: { where: Record<string, unknown>; include?: Record<string, unknown> }): Promise<FormatPackVersionRecord | null>;
  };
};

type DryRunInput = {
  fileId?: string | undefined;
  csvContent: string;
  formatPackVersionId: string;
  statedTotalMinor?: string | bigint | null | undefined;
  source?: string | undefined;
  counterparty?: string | null | undefined;
  brandOrgId?: string | null | undefined;
  resolver?: ShipmentReferenceResolver | undefined;
  persistStagingRows?: boolean | undefined;
};

type RowStatus = "parsed" | "resolved" | "validated" | "exception" | "skipped";

type RowResultInternal = {
  rowNo: number;
  status: RowStatus;
  raw: Record<string, unknown>;
  parsedInternal?: Record<string, unknown> | undefined;
  parsed?: Record<string, unknown> | undefined;
  eventClass?: string | undefined;
  shipmentId?: string | undefined;
  exceptionCode?: string | undefined;
  exceptionDetail?: Record<string, unknown> | undefined;
};

type HeaderResolution = {
  canonicalHeaders: string[];
  indexBySource: Map<string, number>;
};

const defaultClient = prisma as unknown as ParserClient;
const DEFAULT_SOURCE = "courier_mis";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
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

function aliasMap(definition: FormatPackDefinition) {
  const aliases = isObject(definition.headers) && isObject(definition.headers.aliases) ? definition.headers.aliases : {};
  const sourceAliases = new Map<string, string[]>();
  for (const [source, values] of Object.entries(aliases)) {
    const normalized = Array.isArray(values)
      ? values.filter((value): value is string => typeof value === "string").map((value) => normalizeHeader(value))
      : [];
    sourceAliases.set(source, [normalizeHeader(source), ...normalized]);
  }
  return sourceAliases;
}

function resolveSourceMatches(source: string, canonicalHeaders: string[], aliases: Map<string, string[]>) {
  const candidates = aliases.get(source) ?? [normalizeHeader(source)];
  const matches = new Set<number>();
  for (const candidate of candidates) {
    canonicalHeaders.forEach((header, index) => {
      if (header === candidate) matches.add(index);
    });
  }
  return [...matches].sort((left, right) => left - right);
}

function resolveHeaders(headers: string[], definition: FormatPackDefinition): HeaderResolution {
  const canonicalHeaders = headers.map((header) => normalizeHeader(header));
  const aliases = aliasMap(definition);
  const indexBySource = new Map<string, number>();
  const missing: string[] = [];

  if (isObject(definition.headers) && Array.isArray(definition.headers.fingerprint)) {
    for (const item of definition.headers.fingerprint) {
      if (typeof item !== "string") continue;
      const direct = canonicalHeaders.includes(normalizeHeader(item));
      const aliasHit = (aliases.get(item) ?? []).some((alias) => canonicalHeaders.includes(alias));
      if (!direct && !aliasHit) missing.push(item);
    }
  }

  if (isObject(definition.columns)) {
    for (const config of Object.values(definition.columns)) {
      if (!isObject(config) || typeof config.from !== "string") continue;
      const matches = resolveSourceMatches(config.from, canonicalHeaders, aliases);
      if (matches.length > 1) {
        throw new ImportPipelineError("AMBIGUOUS_HEADER", "AMBIGUOUS_HEADER", {
          source: config.from,
          headerIndexes: matches
        });
      }
      if (matches.length === 0) missing.push(config.from);
      else indexBySource.set(config.from, matches[0]!);
    }
  }

  if (missing.length) {
    throw new ImportPipelineError("HEADER_FINGERPRINT_MISMATCH", "HEADER_FINGERPRINT_MISMATCH", { missing: [...new Set(missing)] });
  }

  return { canonicalHeaders, indexBySource };
}

function rawRecord(headers: string[], values: string[]) {
  return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
}

function isBlankRow(values: string[]) {
  return values.every((value) => !String(value ?? "").trim());
}

function isRepeatedHeader(values: string[], headerResolution: HeaderResolution) {
  const normalized = values.map((value) => normalizeHeader(value));
  return normalized.length === headerResolution.canonicalHeaders.length
    && normalized.every((value, index) => value === headerResolution.canonicalHeaders[index]);
}

function shouldSkipRow(values: string[], headerResolution: HeaderResolution, definition: FormatPackDefinition) {
  if (isBlankRow(values)) return "BLANK_ROW";
  if (isRepeatedHeader(values, headerResolution)) return "REPEATED_HEADER";
  const filters = Array.isArray(definition.row_filters) ? definition.row_filters : [];
  const joined = values.map((value) => normalizeHeader(value)).join(" ");
  if (filters.some((filter) => (typeof filter === "string" && filter === "subtotal_row")
    || (isObject(filter) && filter.type === "subtotal_row"))) {
    if (joined.includes("subtotal") || joined === "total" || joined.startsWith("total ")) return "SUBTOTAL_ROW";
  }
  return null;
}

function transformConfigs(config: Record<string, unknown>) {
  return Array.isArray(config.transforms) ? config.transforms as Array<string | Record<string, unknown>> : [];
}

function serializeRow(row: RowResultInternal) {
  return {
    rowNo: row.rowNo,
    status: row.status,
    ...(row.parsed ? { parsed: row.parsed } : {}),
    ...(row.eventClass ? { eventClass: row.eventClass } : {}),
    ...(row.shipmentId ? { shipmentId: row.shipmentId } : {}),
    ...(row.exceptionCode ? { exceptionCode: row.exceptionCode } : {}),
    ...(row.exceptionDetail ? { exceptionDetail: row.exceptionDetail } : {})
  };
}

function duplicateValue(value: unknown) {
  if (typeof value === "bigint") return value.toString();
  return String(value ?? "");
}

function statedTotal(value: string | bigint | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "bigint" ? value : BigInt(value);
}

function incrementCount(counts: Record<string, number>, key: string | undefined) {
  if (!key) return;
  counts[key] = (counts[key] ?? 0) + 1;
}

export class FormatPackParserService {
  constructor(
    private readonly client: ParserClient = defaultClient,
    private readonly stagingRows: StagingRowService = stagingRowService
  ) {}

  async dryRunParseCsv(input: DryRunInput) {
    const version = await this.loadVersion(input.formatPackVersionId);
    const definition = version.definition as FormatPackDefinition;
    formatPackDefinitionValidator.validate(definition);

    const csvRows = parseCsv(input.csvContent);
    const [rawHeaders = [], ...dataRows] = csvRows;
    const headers = rawHeaders.map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, "") : header));
    const headerResolution = resolveHeaders(headers, definition);
    const resolver = input.resolver ?? new NullShipmentReferenceResolver();
    const rowResults: RowResultInternal[] = [];

    for (const [index, values] of dataRows.entries()) {
      const rowNo = index + 2;
      const raw = rawRecord(headers, values);
      const skipCode = shouldSkipRow(values, headerResolution, definition);
      if (skipCode) {
        rowResults.push({ rowNo, raw, status: "skipped", exceptionCode: skipCode });
        continue;
      }

      try {
        const parsedInternal: Record<string, unknown> = {};
        if (isObject(definition.columns)) {
          for (const [fieldKey, columnConfig] of Object.entries(definition.columns)) {
            if (!isObject(columnConfig) || typeof columnConfig.from !== "string") continue;
            const sourceIndex = headerResolution.indexBySource.get(columnConfig.from);
            if (sourceIndex === undefined) throw new ImportPipelineRowError("UNKNOWN_HEADER", { field: fieldKey, source: columnConfig.from });
            let value: unknown = values[sourceIndex] ?? "";
            for (const transform of transformConfigs(columnConfig)) {
              value = applyPrimitive(value, transform, { definition, fieldKey });
            }
            parsedInternal[fieldKey] = value;
          }
        }

        const mappedEvent = typeof parsedInternal.event_class === "string"
          ? parsedInternal.event_class
          : typeof parsedInternal.charge_code === "string" && ALLOWED_EVENT_CLASSES.has(parsedInternal.charge_code)
            ? parsedInternal.charge_code
            : null;
        const eventClass = mappedEvent ?? classifyChargeCode(parsedInternal.charge_code, definition);
        parsedInternal.event_class = eventClass;
        if (typeof parsedInternal.amount_minor === "bigint" && parsedInternal.amount_minor === 0n && eventClass !== "unknown") {
          throw new ImportPipelineRowError("ZERO_AMOUNT", { eventClass });
        }

        let status: RowStatus = "validated";
        let shipmentId: string | undefined;
        const externalRef = typeof parsedInternal.external_awb === "string" ? parsedInternal.external_awb : null;
        if (externalRef) {
          const resolved = await resolver.resolveShipmentRef({
            externalRef,
            source: input.source ?? version.pack?.source ?? String(definition.source ?? DEFAULT_SOURCE),
            counterparty: input.counterparty,
            brandOrgId: input.brandOrgId
          });
          if (resolved) {
            shipmentId = resolved.shipmentId;
            status = "resolved";
          } else if (input.resolver) {
            throw new ImportPipelineRowError("UNRESOLVED_SHIPMENT", { externalRef });
          }
        } else {
          status = "parsed";
        }

        rowResults.push({
          rowNo,
          raw,
          status,
          parsedInternal,
          parsed: serializeParsedValue(parsedInternal) as Record<string, unknown>,
          eventClass,
          shipmentId
        });
      } catch (error) {
        const rowError = error instanceof ImportPipelineRowError
          ? error
          : new ImportPipelineRowError("ROW_PARSE_ERROR", { message: error instanceof Error ? error.message : "Unknown row parse failure" });
        rowResults.push({
          rowNo,
          raw,
          status: "exception",
          exceptionCode: rowError.code,
          exceptionDetail: rowError.details
        });
      }
    }

    this.applyDuplicateDetection(rowResults, definition);
    const parsedTotalMinor = this.parsedTotal(rowResults);
    const expectedTotal = statedTotal(input.statedTotalMinor);
    const fileException = expectedTotal !== null && parsedTotalMinor !== expectedTotal ? "TOTAL_MISMATCH" : null;
    const exceptionCount = rowResults.filter((row) => row.status === "exception").length + (fileException ? 1 : 0);
    const eventClassCounts: Record<string, number> = {};
    for (const row of rowResults) {
      if (row.status !== "exception" && row.status !== "skipped") incrementCount(eventClassCounts, row.eventClass);
    }

    const fileStatus = exceptionCount > 0 ? "exception" : "validated";
    const result = {
      rowCount: dataRows.length,
      parsedCount: rowResults.filter((row) => ["parsed", "validated", "resolved"].includes(row.status)).length,
      resolvedCount: rowResults.filter((row) => row.status === "resolved").length,
      exceptionCount,
      skippedCount: rowResults.filter((row) => row.status === "skipped").length,
      parsedTotalMinor: parsedTotalMinor.toString(),
      ...(expectedTotal !== null ? { statedTotalMinor: expectedTotal.toString() } : {}),
      fileStatus,
      ...(fileException ? { fileExceptionCode: fileException } : {}),
      eventClassCounts,
      rowResults: rowResults.map((row) => serializeRow(row))
    };

    if (input.persistStagingRows) {
      if (!input.fileId) throw new ImportPipelineError("IMPORT_FILE_ID_REQUIRED");
      await this.stagingRows.replaceRows({
        fileId: input.fileId,
        fileStatus: fileStatus === "exception" ? "exception" : "staged",
        rows: rowResults.map((row) => ({
          fileId: input.fileId!,
          rowNo: row.rowNo,
          raw: row.raw,
          parsed: row.parsed ?? null,
          eventClass: row.eventClass ?? null,
          shipmentId: row.shipmentId ?? null,
          status: row.status,
          exceptionCode: row.exceptionCode ?? null,
          exceptionDetail: row.exceptionDetail ?? null
        }))
      });
    }

    return result;
  }

  private async loadVersion(formatPackVersionId: string) {
    const where = { id: formatPackVersionId };
    if (this.client.formatPackVersion.findUnique) {
      const version = await this.client.formatPackVersion.findUnique({ where, include: { pack: true } });
      if (version) return version;
    }
    const version = await this.client.formatPackVersion.findFirst({ where, include: { pack: true } });
    if (!version) throw new ImportPipelineError("FORMAT_PACK_VERSION_NOT_FOUND");
    return version;
  }

  private applyDuplicateDetection(rowResults: RowResultInternal[], definition: FormatPackDefinition) {
    if (!Array.isArray(definition.duplicate_key)) return;
    const seen = new Set<string>();
    for (const row of rowResults) {
      if (row.status === "exception" || row.status === "skipped" || !row.parsedInternal) continue;
      const key = definition.duplicate_key
        .map((field) => typeof field === "string" ? duplicateValue(row.parsedInternal?.[field]) : "")
        .join("|");
      if (seen.has(key)) {
        row.status = "exception";
        row.exceptionCode = "AMBIGUOUS_DUPLICATE";
        row.exceptionDetail = { duplicateKey: key };
      } else {
        seen.add(key);
      }
    }
  }

  private parsedTotal(rowResults: RowResultInternal[]) {
    let total = 0n;
    for (const row of rowResults) {
      if (row.status === "exception" || row.status === "skipped") continue;
      const value = row.parsedInternal?.amount_minor;
      if (typeof value === "bigint") total += value;
    }
    return total;
  }
}

export const formatPackParserService = new FormatPackParserService();

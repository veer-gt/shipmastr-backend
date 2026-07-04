import { createHash } from "node:crypto";
import {
  computeCommandHash,
  type LedgerAccountType,
  type LedgerEntryType,
  type PostLedgerEntryCommand,
  type PostingDirection
} from "../walletLedger/ledger.service.js";
import { ImportPipelineError } from "./import-pipeline.errors.js";

export type ShadowLedgerEventClass =
  | "freight_charged"
  | "rto_freight_charged"
  | "return_freight_charged"
  | "shipment_refund"
  | "weight_dispute_debit"
  | "weight_dispute_credit"
  | "cod_collected"
  | "cod_remitted"
  | "deduction_unattributed"
  | "unknown";

export type ShadowLedgerAccountSet = {
  seller: {
    shippingBalance: string;
    codReceivable: string;
    disputeHold: string;
  };
  courier: {
    courierPayable: string;
    courierCodDue: string;
  };
};

export type ShadowLedgerStagingRow = {
  id: bigint | string;
  fileId: string;
  rowNo: number;
  parsed?: unknown;
  eventClass?: string | null;
  shipmentId?: string | null;
  status: string;
  postedEntryRef?: string | null;
};

export type ShadowLedgerImportFile = {
  id: string;
  formatPackVersionId?: string | null;
};

type PostingPlan = {
  account: keyof ShadowLedgerAccountSet["seller"] | keyof ShadowLedgerAccountSet["courier"];
  owner: "seller" | "courier";
  direction: PostingDirection;
};

type EventMapping = {
  prefix: string;
  entryType: LedgerEntryType;
  narrative: string;
  allowNegative: boolean;
  postings: [PostingPlan, PostingPlan];
};

export type ShadowLedgerMappedCommand = {
  stagingRowId: string;
  eventClass: ShadowLedgerEventClass;
  entryRef: string;
  entryType: LedgerEntryType;
  amountMinor: string;
  parsedHash: string;
  command: PostLedgerEntryCommand;
};

const EVENT_MAPPINGS: Record<Exclude<ShadowLedgerEventClass, "deduction_unattributed" | "unknown">, EventMapping> = {
  freight_charged: {
    prefix: "SHIP",
    entryType: "shipment_charge",
    narrative: "W0 shadow shipment charge",
    allowNegative: false,
    postings: [
      { owner: "seller", account: "shippingBalance", direction: "debit" },
      { owner: "courier", account: "courierPayable", direction: "credit" }
    ]
  },
  rto_freight_charged: {
    prefix: "RTO",
    entryType: "rto_freight_charge",
    narrative: "W0 shadow RTO freight charge",
    allowNegative: false,
    postings: [
      { owner: "seller", account: "shippingBalance", direction: "debit" },
      { owner: "courier", account: "courierPayable", direction: "credit" }
    ]
  },
  return_freight_charged: {
    prefix: "RET",
    entryType: "return_freight_charge",
    narrative: "W0 shadow return freight charge",
    allowNegative: false,
    postings: [
      { owner: "seller", account: "shippingBalance", direction: "debit" },
      { owner: "courier", account: "courierPayable", direction: "credit" }
    ]
  },
  shipment_refund: {
    prefix: "REF",
    entryType: "shipment_refund",
    narrative: "W0 shadow shipment refund",
    allowNegative: true,
    postings: [
      { owner: "courier", account: "courierPayable", direction: "debit" },
      { owner: "seller", account: "shippingBalance", direction: "credit" }
    ]
  },
  weight_dispute_debit: {
    prefix: "WD",
    entryType: "weight_dispute_hold",
    narrative: "W0 shadow weight dispute hold",
    allowNegative: false,
    postings: [
      { owner: "seller", account: "shippingBalance", direction: "debit" },
      { owner: "seller", account: "disputeHold", direction: "credit" }
    ]
  },
  weight_dispute_credit: {
    prefix: "WDR",
    entryType: "weight_dispute_release",
    narrative: "W0 shadow weight dispute release",
    allowNegative: true,
    postings: [
      { owner: "seller", account: "disputeHold", direction: "debit" },
      { owner: "seller", account: "shippingBalance", direction: "credit" }
    ]
  },
  cod_collected: {
    prefix: "COD",
    entryType: "cod_collected",
    narrative: "W0 shadow COD collected",
    allowNegative: false,
    postings: [
      { owner: "courier", account: "courierCodDue", direction: "debit" },
      { owner: "seller", account: "codReceivable", direction: "credit" }
    ]
  },
  cod_remitted: {
    prefix: "CODR",
    entryType: "cod_remittance_in",
    narrative: "W0 shadow COD remitted",
    allowNegative: false,
    postings: [
      { owner: "seller", account: "codReceivable", direction: "debit" },
      { owner: "courier", account: "courierCodDue", direction: "credit" }
    ]
  }
};

const ALLOWED_EVENT_CLASSES = new Set<ShadowLedgerEventClass>([
  "freight_charged",
  "rto_freight_charged",
  "return_freight_charged",
  "shipment_refund",
  "weight_dispute_debit",
  "weight_dispute_credit",
  "cod_collected",
  "cod_remitted",
  "deduction_unattributed",
  "unknown"
]);

export const W0C1_SHADOW_ACCOUNT_TYPES: Readonly<Record<"seller" | "courier", LedgerAccountType[]>> = {
  seller: ["shipping_balance", "cod_receivable", "dispute_hold"],
  courier: ["courier_payable", "courier_cod_due"]
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (typeof value === "bigint") return `"${value.toString()}"`;
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function shortHash(value: string, length = 24) {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, length);
}

function requireEventClass(value: unknown): ShadowLedgerEventClass {
  const eventClass = String(value ?? "").trim();
  if (!ALLOWED_EVENT_CLASSES.has(eventClass as ShadowLedgerEventClass)) {
    throw new ImportPipelineError("UNKNOWN_EVENT_CLASS", "UNKNOWN_EVENT_CLASS", { eventClass });
  }
  return eventClass as ShadowLedgerEventClass;
}

function parsedRecord(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new ImportPipelineError("MISSING_AMOUNT", "MISSING_AMOUNT");
  return value;
}

export function parsePostingAmountMinor(value: unknown, options: { allowNegative: boolean }) {
  const text = String(value ?? "").trim();
  if (!text) throw new ImportPipelineError("MISSING_AMOUNT", "MISSING_AMOUNT");
  if (!/^-?[0-9]+$/.test(text)) throw new ImportPipelineError("BAD_AMOUNT", "BAD_AMOUNT");
  const amount = BigInt(text);
  if (amount === 0n) throw new ImportPipelineError("ZERO_AMOUNT", "ZERO_AMOUNT");
  if (amount < 0n && !options.allowNegative) {
    throw new ImportPipelineError("NEGATIVE_AMOUNT_UNSUPPORTED", "NEGATIVE_AMOUNT_UNSUPPORTED");
  }
  return amount < 0n ? -amount : amount;
}

function accountId(accounts: ShadowLedgerAccountSet, plan: PostingPlan) {
  return accounts[plan.owner][plan.account as never] as string;
}

function sourceRefForShipment(shipmentId: string) {
  return `shp_${shortHash(`shipment:${shipmentId}`)}`;
}

export function mapStagingRowToShadowLedgerCommand(input: {
  importFile: ShadowLedgerImportFile;
  row: ShadowLedgerStagingRow;
  accounts: ShadowLedgerAccountSet;
  createdBy: string;
}): ShadowLedgerMappedCommand {
  if (input.row.status === "exception") throw new ImportPipelineError("ROW_NOT_READY", "ROW_NOT_READY");
  if (!["validated", "resolved", "ready_for_posting"].includes(input.row.status)) {
    throw new ImportPipelineError("ROW_NOT_READY", "ROW_NOT_READY", { status: input.row.status });
  }
  if (!input.row.shipmentId) throw new ImportPipelineError("MISSING_SHIPMENT_ID", "MISSING_SHIPMENT_ID");

  const eventClass = requireEventClass(input.row.eventClass);
  if (eventClass === "deduction_unattributed") {
    throw new ImportPipelineError("UNATTRIBUTED_DEDUCTION_NOT_POSTED", "UNATTRIBUTED_DEDUCTION_NOT_POSTED");
  }
  if (eventClass === "unknown") {
    throw new ImportPipelineError("UNKNOWN_EVENT_CLASS", "UNKNOWN_EVENT_CLASS");
  }

  const mapping = EVENT_MAPPINGS[eventClass];
  const parsed = parsedRecord(input.row.parsed);
  const amount = parsePostingAmountMinor(parsed.amount_minor, { allowNegative: mapping.allowNegative });
  const parsedHash = shortHash(stableJson(parsed), 16);
  const stagingRowId = String(input.row.id);
  const entryRef = `W0IMP-${mapping.prefix}-${shortHash(`${stagingRowId}:${input.importFile.id}:${eventClass}:${parsedHash}`)}`;
  const sourceRef = sourceRefForShipment(input.row.shipmentId);
  const postings = mapping.postings.map((plan) => ({
    accountId: accountId(input.accounts, plan),
    direction: plan.direction,
    amountPaise: amount.toString(),
    currency: "INR"
  }));
  const commandWithoutHash: Omit<PostLedgerEntryCommand, "commandHash"> = {
    entryRef,
    entryType: mapping.entryType,
    ledgerScope: "shadow",
    currency: "INR",
    sourceType: "shipment",
    sourceRef,
    narrative: mapping.narrative,
    createdBy: input.createdBy,
    postings,
    metadata: {
      stagingRowId,
      importFileId: input.importFile.id,
      formatPackVersionId: input.importFile.formatPackVersionId ?? null,
      parsedHash
    }
  };
  const commandHash = computeCommandHash(commandWithoutHash);

  return {
    stagingRowId,
    eventClass,
    entryRef,
    entryType: mapping.entryType,
    amountMinor: amount.toString(),
    parsedHash,
    command: { ...commandWithoutHash, commandHash }
  };
}

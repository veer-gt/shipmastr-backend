import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";

export const CHECKOUT_MODES = ["prepaid", "partial_cod", "full_cod"] as const;
export type CheckoutMode = (typeof CHECKOUT_MODES)[number];
export type CheckoutOptionKey = CheckoutMode;

export type CheckoutItemInput = {
  id: string;
  name?: string | undefined;
  quantity: number;
  priceMinor: string | number;
};

export type CheckoutItem = {
  id: string;
  name: string | null;
  quantity: bigint;
  priceMinor: bigint;
};

export type CheckoutOption = {
  key: CheckoutOptionKey;
  label: string;
  available: boolean;
  reason: string | null;
  payNow: bigint;
  payOnDelivery: bigint;
  codFee: bigint;
  discount: bigint;
  total: bigint;
  badge: string | null;
  currency: string;
};

export type CheckoutQuoteResult = {
  quoteId: string;
  expiresAt: Date;
  currency: string;
  itemsTotal: bigint;
  pincode: string;
  options: Record<CheckoutOptionKey, CheckoutOption>;
  riskNotes: string[];
};

export type CheckoutChargeRule = {
  type: "flat" | "percent_bps";
  valueMinor?: string | number | bigint | undefined;
  valueBps?: string | number | bigint | undefined;
  minMinor?: string | number | bigint | undefined;
  maxMinor?: string | number | bigint | undefined;
  waiveAboveCartMinor?: string | number | bigint | undefined;
};

export type CheckoutRules = {
  cod: {
    enabled: boolean;
    minCartMinor: string | number | bigint;
    maxCartMinor?: string | number | bigint | null | undefined;
    fee: CheckoutChargeRule;
    blockedPincodes: string[];
  };
  partial: {
    enabled: boolean;
    minCartMinor: string | number | bigint;
    advance: CheckoutChargeRule;
    waiveCodFee: boolean;
  };
  prepaid: {
    discount: CheckoutChargeRule;
  };
  risky: {
    pincodes: string[];
    policy: "none" | "force_advance";
  };
};

type DbClient = typeof prisma | any;

export const DEFAULT_CHECKOUT_RULES: CheckoutRules = {
  cod: {
    enabled: true,
    minCartMinor: "30000",
    maxCartMinor: "2000000",
    fee: {
      type: "flat",
      valueMinor: "4900",
      waiveAboveCartMinor: "300000"
    },
    blockedPincodes: []
  },
  partial: {
    enabled: true,
    minCartMinor: "30000",
    advance: {
      type: "percent_bps",
      valueBps: "2000",
      minMinor: "10000",
      maxMinor: "50000"
    },
    waiveCodFee: true
  },
  prepaid: {
    discount: {
      type: "percent_bps",
      valueBps: "500",
      maxMinor: "25000"
    }
  },
  risky: {
    pincodes: [],
    policy: "none"
  }
};

const PINCODE_PATTERN = /^\d{6}$/;
const MAX_SAFE_JSON_MINOR = 9007199254740991n;

export function parseMinorUnit(value: string | number | bigint, field: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new HttpError(400, "INVALID_MONEY_MINOR", { field });
    return value;
  }

  if (typeof value === "number") {
    if (!globalThis.Number.isSafeInteger(value) || value < 0) {
      throw new HttpError(400, "INVALID_MONEY_MINOR", { field });
    }
    return BigInt(value.toString());
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new HttpError(400, "INVALID_MONEY_MINOR", { field });
  }
  return BigInt(trimmed);
}

export function minorToJsonInteger(value: bigint): number {
  if (value < 0n || value > MAX_SAFE_JSON_MINOR) {
    throw new HttpError(500, "CHECKOUT_AMOUNT_OUT_OF_JSON_SAFE_RANGE");
  }
  return parseInt(value.toString(), 10);
}

function parseOptionalMinor(value: string | number | bigint | null | undefined, field: string): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  return parseMinorUnit(value, field);
}

function parseBps(value: string | number | bigint | undefined, field: string): bigint {
  if (value === undefined) throw new HttpError(400, "INVALID_BPS", { field });
  const bps = parseMinorUnit(value, field);
  if (bps > 10000n) throw new HttpError(400, "INVALID_BPS", { field });
  return bps;
}

function clamp(value: bigint, min: bigint | null, max: bigint | null) {
  let next = value;
  if (min !== null && next < min) next = min;
  if (max !== null && next > max) next = max;
  return next;
}

function calculateCharge(rule: CheckoutChargeRule | undefined, baseMinor: bigint, field: string): bigint {
  if (!rule) return 0n;
  let amount = 0n;
  if (rule.type === "flat") {
    amount = parseMinorUnit(rule.valueMinor ?? "0", `${field}.valueMinor`);
  } else if (rule.type === "percent_bps") {
    amount = (baseMinor * parseBps(rule.valueBps, `${field}.valueBps`)) / 10000n;
  } else {
    throw new HttpError(400, "INVALID_CHARGE_RULE", { field });
  }

  return clamp(
    amount,
    parseOptionalMinor(rule.minMinor, `${field}.minMinor`),
    parseOptionalMinor(rule.maxMinor, `${field}.maxMinor`)
  );
}

function formatRupees(minor: bigint) {
  const rupees = minor / 100n;
  const paise = minor % 100n;
  if (paise === 0n) return `₹${rupees.toString()}`;
  return `₹${rupees.toString()}.${paise.toString().padStart(2, "0")}`;
}

function option(key: CheckoutOptionKey, label: string, extra: Partial<CheckoutOption>): CheckoutOption {
  return {
    key,
    label,
    available: false,
    reason: null,
    payNow: 0n,
    payOnDelivery: 0n,
    codFee: 0n,
    discount: 0n,
    total: 0n,
    badge: null,
    currency: "INR",
    ...extra
  };
}

function normalizePincode(pincode: string) {
  const normalized = pincode.trim();
  if (!PINCODE_PATTERN.test(normalized)) {
    throw new HttpError(400, "INVALID_PINCODE");
  }
  return normalized;
}

export function normalizeCheckoutItems(items: CheckoutItemInput[]): CheckoutItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(400, "CHECKOUT_ITEMS_REQUIRED");
  }

  return items.map((item, index) => {
    const id = item.id?.trim();
    if (!id) throw new HttpError(400, "CHECKOUT_ITEM_REF_REQUIRED", { index });
    if (!globalThis.Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new HttpError(400, "CHECKOUT_ITEM_QUANTITY_INVALID", { index });
    }

    return {
      id,
      name: item.name?.trim() || null,
      quantity: BigInt(item.quantity.toString()),
      priceMinor: parseMinorUnit(item.priceMinor, `items.${index}.priceMinor`)
    };
  });
}

export function serializeItemsForJson(items: CheckoutItem[]) {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    quantity: minorToJsonInteger(item.quantity),
    priceMinor: minorToJsonInteger(item.priceMinor)
  }));
}

function itemsTotal(items: CheckoutItem[]) {
  return items.reduce((sum, item) => sum + item.quantity * item.priceMinor, 0n);
}

export function computeCheckoutQuote(input: {
  items: CheckoutItem[];
  pincode: string;
  rules?: CheckoutRules | null | undefined;
}): Omit<CheckoutQuoteResult, "quoteId" | "expiresAt"> {
  const rules = input.rules ?? DEFAULT_CHECKOUT_RULES;
  const pincode = normalizePincode(input.pincode);
  const total = itemsTotal(input.items);
  const blockedPincodes = new Set(rules.cod.blockedPincodes.map((pin) => String(pin)));
  const riskyPincodes = new Set(rules.risky.pincodes.map((pin) => String(pin)));
  const risky = riskyPincodes.has(pincode);
  const forceAdvance = risky && rules.risky.policy === "force_advance";

  const prepaidDiscount = total > 0n ? clamp(calculateCharge(rules.prepaid.discount, total, "prepaid.discount"), null, total) : 0n;
  const prepaid = option("prepaid", "Pay full amount now", {
    available: total > 0n,
    reason: total > 0n ? null : "Cart is empty",
    payNow: total - prepaidDiscount,
    discount: prepaidDiscount,
    total: total - prepaidDiscount,
    badge: prepaidDiscount > 0n ? `Save ${formatRupees(prepaidDiscount)}` : null
  });

  const codBlockers: string[] = [];
  const codMin = parseMinorUnit(rules.cod.minCartMinor, "cod.minCartMinor");
  const codMax = parseOptionalMinor(rules.cod.maxCartMinor, "cod.maxCartMinor");
  if (total <= 0n) codBlockers.push("Cart is empty");
  if (!rules.cod.enabled) codBlockers.push("Cash on delivery is disabled for this store");
  if (total > 0n && total < codMin) codBlockers.push(`COD available on orders above ${formatRupees(codMin)}`);
  if (codMax !== null && total > codMax) codBlockers.push(`COD not available above ${formatRupees(codMax)}`);
  if (blockedPincodes.has(pincode)) codBlockers.push("COD is not serviceable for this pincode");

  const codFeeBase = calculateCharge(rules.cod.fee, total, "cod.fee");
  const waiveAboveCart = parseOptionalMinor(rules.cod.fee.waiveAboveCartMinor, "cod.fee.waiveAboveCartMinor");
  const codFeeWaivedByCart = waiveAboveCart !== null && total >= waiveAboveCart;
  const codFee = codFeeWaivedByCart ? 0n : codFeeBase;

  const fullBlockers = [...codBlockers];
  if (forceAdvance) fullBlockers.push("Full COD is unavailable for this pincode — a small advance is required");
  const fullCod = option("full_cod", "Full cash on delivery", {
    available: fullBlockers.length === 0,
    reason: fullBlockers[0] ?? null,
    payOnDelivery: total + codFee,
    codFee,
    total: total + codFee,
    badge: codFee > 0n ? `+${formatRupees(codFee)} COD fee` : codFeeWaivedByCart && codFeeBase > 0n ? "COD fee waived" : null
  });

  const partialBlockers = [...codBlockers];
  if (!rules.partial.enabled) partialBlockers.push("Partial COD is disabled for this store");
  const partialMin = parseMinorUnit(rules.partial.minCartMinor, "partial.minCartMinor");
  if (total > 0n && total < partialMin) partialBlockers.push(`Partial COD available on orders above ${formatRupees(partialMin)}`);
  const advance = clamp(calculateCharge(rules.partial.advance, total, "partial.advance"), null, total);
  const partialCodFee = rules.partial.waiveCodFee ? 0n : codFee;
  const partialCod = option("partial_cod", "Pay a small advance, rest on delivery", {
    available: partialBlockers.length === 0,
    reason: partialBlockers[0] ?? null,
    payNow: advance,
    payOnDelivery: total - advance + partialCodFee,
    codFee: partialCodFee,
    total: total + partialCodFee,
    badge: rules.partial.waiveCodFee && codFee > 0n ? "COD fee waived" : null
  });

  const riskNotes = risky ? [`Pincode ${pincode} flagged for checkout COD risk policy ${rules.risky.policy}`] : [];

  return {
    currency: "INR",
    itemsTotal: total,
    pincode,
    options: {
      prepaid,
      partial_cod: partialCod,
      full_cod: fullCod
    },
    riskNotes
  };
}

export function quoteOptionsToJson(options: Record<CheckoutOptionKey, CheckoutOption>) {
  return Object.fromEntries(CHECKOUT_MODES.map((mode) => {
    const current = options[mode];
    return [mode, {
      ...current,
      payNow: current.payNow.toString(),
      payOnDelivery: current.payOnDelivery.toString(),
      codFee: current.codFee.toString(),
      discount: current.discount.toString(),
      total: current.total.toString()
    }];
  }));
}

export function quoteOptionsFromJson(value: unknown): Record<CheckoutOptionKey, CheckoutOption> {
  const record = value as Record<string, Record<string, unknown>>;
  return Object.fromEntries(CHECKOUT_MODES.map((mode) => {
    const current = record[mode];
    if (!current) throw new HttpError(500, "CHECKOUT_QUOTE_OPTION_MISSING", { mode });
    return [mode, {
      key: mode,
      label: String(current.label ?? mode),
      available: Boolean(current.available),
      reason: typeof current.reason === "string" ? current.reason : null,
      payNow: parseMinorUnit(String(current.payNow ?? "0"), `${mode}.payNow`),
      payOnDelivery: parseMinorUnit(String(current.payOnDelivery ?? "0"), `${mode}.payOnDelivery`),
      codFee: parseMinorUnit(String(current.codFee ?? "0"), `${mode}.codFee`),
      discount: parseMinorUnit(String(current.discount ?? "0"), `${mode}.discount`),
      total: parseMinorUnit(String(current.total ?? "0"), `${mode}.total`),
      badge: typeof current.badge === "string" ? current.badge : null,
      currency: String(current.currency ?? "INR")
    }];
  })) as Record<CheckoutOptionKey, CheckoutOption>;
}

export class CheckoutQuoteService {
  constructor(
    private readonly client: DbClient = prisma,
    private readonly now: () => Date = () => new Date()
  ) {}

  async createQuote(input: { merchantId: string; items: CheckoutItemInput[]; pincode: string }) {
    const merchantId = input.merchantId.trim();
    if (!merchantId) throw new HttpError(400, "CHECKOUT_MERCHANT_REQUIRED");
    const merchant = await this.client.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) throw new HttpError(404, "CHECKOUT_MERCHANT_NOT_FOUND");

    const settings = await this.client.checkoutMerchantSetting?.findUnique?.({
      where: { merchantId },
      include: { activeRulesVersion: true }
    });
    const activeRules = settings?.activeRulesVersion?.rulesJson as CheckoutRules | undefined;
    const quoteTtlSeconds = settings?.quoteTtlSeconds ?? 900;
    const items = normalizeCheckoutItems(input.items);
    const quote = computeCheckoutQuote({
      items,
      pincode: input.pincode,
      rules: activeRules ?? DEFAULT_CHECKOUT_RULES
    });
    const expiresAt = new Date(this.now().getTime() + quoteTtlSeconds * 1000);
    const created = await this.client.checkoutQuote.create({
      data: {
        merchantId,
        rulesVersionId: settings?.activeRulesVersion?.id ?? null,
        pincode: quote.pincode,
        currency: quote.currency,
        itemsJson: serializeItemsForJson(items),
        itemsTotalMinor: quote.itemsTotal,
        optionsJson: quoteOptionsToJson(quote.options),
        riskNotes: quote.riskNotes,
        expiresAt
      }
    });

    return {
      ...quote,
      quoteId: created.id,
      expiresAt
    };
  }
}

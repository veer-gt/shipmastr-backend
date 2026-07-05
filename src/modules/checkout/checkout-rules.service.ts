import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { DEFAULT_CHECKOUT_RULES, type CheckoutRules, parseMinorUnit } from "./checkout-quote.service.js";

type DbClient = typeof prisma | any;

function ensureBoolean(value: unknown, code: string) {
  if (typeof value !== "boolean") throw new HttpError(400, code);
}

function ensurePincodes(value: unknown, code: string) {
  if (!Array.isArray(value) || value.some((pin) => !/^\d{6}$/.test(String(pin)))) {
    throw new HttpError(400, code);
  }
}

function validateCharge(rule: any, code: string) {
  if (!rule || !["flat", "percent_bps"].includes(rule.type)) throw new HttpError(400, code);
  if (rule.type === "flat") {
    parseMinorUnit(rule.valueMinor ?? "0", `${code}.valueMinor`);
  } else {
    const bps = parseMinorUnit(rule.valueBps ?? "0", `${code}.valueBps`);
    if (bps > 10000n) throw new HttpError(400, code);
  }
  if (rule.minMinor !== undefined && rule.minMinor !== null) parseMinorUnit(rule.minMinor, `${code}.minMinor`);
  if (rule.maxMinor !== undefined && rule.maxMinor !== null) parseMinorUnit(rule.maxMinor, `${code}.maxMinor`);
  if (rule.waiveAboveCartMinor !== undefined && rule.waiveAboveCartMinor !== null) {
    parseMinorUnit(rule.waiveAboveCartMinor, `${code}.waiveAboveCartMinor`);
  }
}

export function validateCheckoutRules(rules: CheckoutRules) {
  ensureBoolean(rules.cod?.enabled, "CHECKOUT_RULE_COD_ENABLED_INVALID");
  parseMinorUnit(rules.cod.minCartMinor, "cod.minCartMinor");
  if (rules.cod.maxCartMinor !== undefined && rules.cod.maxCartMinor !== null) parseMinorUnit(rules.cod.maxCartMinor, "cod.maxCartMinor");
  validateCharge(rules.cod.fee, "CHECKOUT_RULE_COD_FEE_INVALID");
  ensurePincodes(rules.cod.blockedPincodes, "CHECKOUT_RULE_BLOCKED_PINCODES_INVALID");

  ensureBoolean(rules.partial?.enabled, "CHECKOUT_RULE_PARTIAL_ENABLED_INVALID");
  parseMinorUnit(rules.partial.minCartMinor, "partial.minCartMinor");
  validateCharge(rules.partial.advance, "CHECKOUT_RULE_PARTIAL_ADVANCE_INVALID");
  ensureBoolean(rules.partial.waiveCodFee, "CHECKOUT_RULE_PARTIAL_WAIVE_COD_FEE_INVALID");

  validateCharge(rules.prepaid?.discount, "CHECKOUT_RULE_PREPAID_DISCOUNT_INVALID");

  ensurePincodes(rules.risky?.pincodes, "CHECKOUT_RULE_RISKY_PINCODES_INVALID");
  if (!["none", "force_advance"].includes(rules.risky.policy)) {
    throw new HttpError(400, "CHECKOUT_RULE_RISKY_POLICY_INVALID");
  }

  return rules;
}

export class CheckoutRulesService {
  constructor(private readonly client: DbClient = prisma) {}

  async getActiveRules(merchantId: string): Promise<CheckoutRules> {
    const settings = await this.client.checkoutMerchantSetting?.findUnique?.({
      where: { merchantId },
      include: { activeRulesVersion: true }
    });
    if (!settings?.activeRulesVersion?.rulesJson) return DEFAULT_CHECKOUT_RULES;
    return validateCheckoutRules(settings.activeRulesVersion.rulesJson as CheckoutRules);
  }
}

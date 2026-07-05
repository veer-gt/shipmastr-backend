import { HttpError } from "../../lib/httpError.js";
import { env } from "../../config/env.js";
import { LedgerService } from "../walletLedger/ledger.service.js";
import {
  ClosedLoopWalletProvisioningService,
  ClosedLoopWalletService,
  W1WalletReadinessService,
  WalletClosurePolicyService,
  WalletHoldService,
  WalletStatementService,
  WalletTopupSandboxService,
  type W1Client,
  type W1RuntimeConfig,
  type W1ServiceDeps
} from "./w1-closed-loop-wallet.service.js";

type MoneyText = string;

type W1SmokeAmounts = {
  topupMinor: MoneyText;
  holdMinor: MoneyText;
  captureMinor: MoneyText;
  refundMinor: MoneyText;
};

type W1SmokeInput = {
  sellerOrgId?: string | undefined;
  createdBy?: string | undefined;
  period?: string | undefined;
  execute?: boolean | undefined;
  dryRun?: boolean | undefined;
  amounts?: Partial<W1SmokeAmounts> | undefined;
};

type W1SmokeDeps = W1ServiceDeps & {
  provisioning?: ClosedLoopWalletProvisioningService | undefined;
  topup?: WalletTopupSandboxService | undefined;
  hold?: WalletHoldService | undefined;
  wallet?: ClosedLoopWalletService | undefined;
  statement?: WalletStatementService | undefined;
  closure?: WalletClosurePolicyService | undefined;
  readiness?: W1WalletReadinessService | undefined;
};

const DEFAULT_COURIER_CODE = "BIGSHIP_SYNTHETIC";
const DEFAULT_SELLER_ORG_ID = "org_w1c_sandbox_seller";
const DEFAULT_CREATED_BY = "usr_w1c_operator";
const DEFAULT_PERIOD = "2026-07";

export const w1cFixtureAmounts: W1SmokeAmounts = {
  topupMinor: "100000",
  holdMinor: "45000",
  captureMinor: "42000",
  refundMinor: "7000"
};

const expectedFinalSummary = {
  postedMinor: "65000",
  heldMinor: "0",
  availableMinor: "65000"
} as const;

function resolveConfig(override?: Partial<W1RuntimeConfig>): W1RuntimeConfig {
  return {
    enabled: env.WALLET_W1_ENABLED,
    sandboxOnly: env.WALLET_W1_SANDBOX_ONLY,
    allowLivePayments: env.WALLET_W1_ALLOW_LIVE_PAYMENTS,
    allowCashout: env.WALLET_W1_ALLOW_CASHOUT,
    appEnv: env.APP_ENV,
    nodeEnv: env.NODE_ENV,
    ...override
  };
}

function requiredText(value: string | undefined, fallback: string, code: string) {
  const next = (value ?? fallback).trim();
  if (!next) throw new HttpError(400, code);
  return next;
}

function cleanPeriod(value: string | undefined) {
  const next = requiredText(value, DEFAULT_PERIOD, "W1C_PERIOD_REQUIRED");
  if (!/^[0-9]{4}-[0-9]{2}$/u.test(next)) throw new HttpError(400, "W1C_PERIOD_INVALID");
  return next;
}

function refPeriod(period: string) {
  return period.replace(/-/gu, "_");
}

function moneyText(value: string | undefined, fallback: string, code: string) {
  const next = (value ?? fallback).trim();
  if (!/^[0-9]+$/u.test(next)) throw new HttpError(400, code);
  return next;
}

function moneyBigInt(value: string) {
  return BigInt(value);
}

function moneyDifference(left: string, right: string) {
  return (moneyBigInt(left) - moneyBigInt(right)).toString();
}

function resolveAmounts(input?: Partial<W1SmokeAmounts>): W1SmokeAmounts {
  return {
    topupMinor: moneyText(input?.topupMinor, w1cFixtureAmounts.topupMinor, "W1C_TOPUP_AMOUNT_INVALID"),
    holdMinor: moneyText(input?.holdMinor, w1cFixtureAmounts.holdMinor, "W1C_HOLD_AMOUNT_INVALID"),
    captureMinor: moneyText(input?.captureMinor, w1cFixtureAmounts.captureMinor, "W1C_CAPTURE_AMOUNT_INVALID"),
    refundMinor: moneyText(input?.refundMinor, w1cFixtureAmounts.refundMinor, "W1C_REFUND_AMOUNT_INVALID")
  };
}

function normalizedInput(input: W1SmokeInput = {}) {
  const sellerOrgId = requiredText(input.sellerOrgId, DEFAULT_SELLER_ORG_ID, "W1C_SELLER_ORG_ID_REQUIRED");
  const createdBy = requiredText(input.createdBy, DEFAULT_CREATED_BY, "W1C_CREATED_BY_REQUIRED");
  const period = cleanPeriod(input.period);
  const amounts = resolveAmounts(input.amounts);
  const suffix = refPeriod(period);
  return {
    sellerOrgId,
    createdBy,
    period,
    amounts,
    topupSourceRef: `topup_w1c_${suffix}`,
    shipmentRef: `shp_w1c_${suffix}`,
    courierCode: DEFAULT_COURIER_CODE
  };
}

function assertExecuteAllowed(config: W1RuntimeConfig) {
  if (!config.enabled) throw new HttpError(403, "WALLET_W1_DISABLED");
  if (config.nodeEnv === "production" || config.appEnv === "production") {
    throw new HttpError(403, "W1C_PRODUCTION_EXECUTE_FORBIDDEN");
  }
  if (!["development", "test"].includes(config.appEnv)) {
    throw new HttpError(403, "W1C_LOCAL_TEST_EXECUTE_REQUIRED");
  }
  if (!config.sandboxOnly) throw new HttpError(403, "WALLET_W1_LIVE_MODE_FORBIDDEN");
  if (config.allowLivePayments) throw new HttpError(403, "WALLET_W1_LIVE_PAYMENTS_FORBIDDEN");
  if (config.allowCashout) throw new HttpError(403, "WALLET_W1_CASHOUT_FORBIDDEN");
}

function blockedAction(action: string, callback: () => void) {
  try {
    callback();
    return { action, refused: false, code: null };
  } catch (error) {
    return {
      action,
      refused: true,
      code: error instanceof Error ? error.message : String(error)
    };
  }
}

export class W1SandboxSmokeService {
  private readonly config: W1RuntimeConfig;
  private readonly provisioning: ClosedLoopWalletProvisioningService;
  private readonly topup: WalletTopupSandboxService;
  private readonly hold: WalletHoldService;
  private readonly wallet: ClosedLoopWalletService;
  private readonly statement: WalletStatementService;
  private readonly closure: WalletClosurePolicyService;
  private readonly readiness: W1WalletReadinessService;

  constructor(deps: W1SmokeDeps = {}) {
    this.config = resolveConfig(deps.config);
    const serviceDeps: W1ServiceDeps = { config: this.config };
    if (deps.client) serviceDeps.client = deps.client;
    if (deps.ledger) serviceDeps.ledger = deps.ledger;
    this.provisioning = deps.provisioning ?? new ClosedLoopWalletProvisioningService(serviceDeps);
    this.topup = deps.topup ?? new WalletTopupSandboxService({ ...serviceDeps, provisioning: this.provisioning });
    this.hold = deps.hold ?? new WalletHoldService({ ...serviceDeps, provisioning: this.provisioning });
    this.wallet = deps.wallet ?? new ClosedLoopWalletService({ ...serviceDeps, provisioning: this.provisioning });
    this.statement = deps.statement ?? new WalletStatementService({ ...(deps.client ? { client: deps.client } : {}), config: this.config });
    this.closure = deps.closure ?? new WalletClosurePolicyService(this.config);
    this.readiness = deps.readiness ?? new W1WalletReadinessService(this.config);
  }

  async run(input: W1SmokeInput = {}) {
    const execute = input.execute === true && input.dryRun !== true;
    return execute ? this.execute(input) : this.plan(input);
  }

  plan(input: W1SmokeInput = {}) {
    const normalized = normalizedInput(input);
    const releasedUnusedMinor = moneyDifference(normalized.amounts.holdMinor, normalized.amounts.captureMinor);
    const readiness = this.readiness.checkReadiness();
    return {
      ok: readiness.ok,
      dryRun: true,
      execute: false,
      sandboxOnly: this.config.sandboxOnly,
      sellerOrgId: normalized.sellerOrgId,
      period: normalized.period,
      readiness,
      amounts: {
        ...normalized.amounts,
        releasedUnusedMinor,
        expectedFinalPostedMinor: expectedFinalSummary.postedMinor,
        expectedFinalHeldMinor: expectedFinalSummary.heldMinor,
        expectedFinalAvailableMinor: expectedFinalSummary.availableMinor
      },
      refs: {
        topupSourceRef: normalized.topupSourceRef,
        shipmentRef: normalized.shipmentRef,
        courierCode: normalized.courierCode
      },
      steps: [
        "readiness",
        "provision_wallet",
        "create_topup_intent",
        "confirm_topup",
        "read_summary_after_topup",
        "place_hold",
        "capture_charge",
        "verify_unused_hold_released",
        "read_summary_after_capture",
        "post_wallet_only_refund",
        "read_statement",
        "verify_unsupported_actions_refused"
      ],
      writes: {
        accounts: 0,
        intents: 0,
        holds: 0,
        entries: 0
      }
    };
  }

  private async execute(input: W1SmokeInput = {}) {
    assertExecuteAllowed(this.config);
    const normalized = normalizedInput(input);
    const releasedUnusedMinor = moneyDifference(normalized.amounts.holdMinor, normalized.amounts.captureMinor);

    const readiness = this.readiness.checkReadiness();
    if (!readiness.ok) throw new HttpError(403, "W1C_READINESS_BLOCKED", readiness.blockingIssues);

    const wallet = await this.provisioning.ensureSellerClosedLoopWallet({
      sellerOrgId: normalized.sellerOrgId,
      createdBy: normalized.createdBy,
      sandboxOnly: true
    });
    const topupIntent = await this.topup.createSandboxTopupIntent({
      sellerOrgId: normalized.sellerOrgId,
      amountMinor: normalized.amounts.topupMinor,
      sourceRef: normalized.topupSourceRef,
      createdBy: normalized.createdBy
    });
    const topupConfirmation = await this.topup.confirmSandboxTopup({
      sellerOrgId: normalized.sellerOrgId,
      topupRef: topupIntent.intent.topupRef,
      amountMinor: normalized.amounts.topupMinor,
      createdBy: normalized.createdBy
    });
    const summaryAfterTopup = await this.statement.getWalletSummary(normalized.sellerOrgId);

    const hold = await this.hold.placeShipmentEstimateHold({
      sellerOrgId: normalized.sellerOrgId,
      shipmentId: normalized.shipmentRef,
      amountMinor: normalized.amounts.holdMinor,
      createdBy: normalized.createdBy
    });
    const capture = await this.wallet.captureShipmentCharge({
      sellerOrgId: normalized.sellerOrgId,
      courierCode: normalized.courierCode,
      shipmentId: normalized.shipmentRef,
      holdId: hold.hold.id,
      amountMinor: normalized.amounts.captureMinor,
      createdBy: normalized.createdBy
    });
    const summaryAfterCapture = await this.statement.getWalletSummary(normalized.sellerOrgId);

    const refund = await this.wallet.postShipmentRefund({
      sellerOrgId: normalized.sellerOrgId,
      courierCode: normalized.courierCode,
      shipmentId: normalized.shipmentRef,
      amountMinor: normalized.amounts.refundMinor,
      createdBy: normalized.createdBy
    });
    const finalSummary = await this.statement.getWalletSummary(normalized.sellerOrgId);
    const statement = await this.statement.getWalletStatement(normalized.sellerOrgId);
    const blockers = [
      blockedAction("mid_life_cashout", () => this.closure.assertMidLifeBankCashoutForbidden()),
      blockedAction("closure_bank_settlement", () => this.closure.assertClosureBankSettlementBlocked())
    ];

    const summaryMatches = finalSummary.postedMinor === expectedFinalSummary.postedMinor
      && finalSummary.heldMinor === expectedFinalSummary.heldMinor
      && finalSummary.availableMinor === expectedFinalSummary.availableMinor;
    if (!summaryMatches) {
      throw new HttpError(409, "W1C_FINAL_SUMMARY_MISMATCH", { expected: expectedFinalSummary, actual: finalSummary });
    }
    if (blockers.some((blocker) => !blocker.refused)) {
      throw new HttpError(409, "W1C_UNSUPPORTED_ACTION_NOT_REFUSED", blockers);
    }

    return {
      ok: true,
      dryRun: false,
      execute: true,
      sandboxOnly: this.config.sandboxOnly,
      sellerOrgId: normalized.sellerOrgId,
      period: normalized.period,
      readiness,
      wallet: {
        ownerId: wallet.owner.id,
        shippingBalanceAccountId: wallet.accounts.shippingBalance.id,
        disputeHoldAccountId: wallet.accounts.disputeHold.id
      },
      amounts: {
        ...normalized.amounts,
        releasedUnusedMinor
      },
      refs: {
        topupRef: topupIntent.intent.topupRef,
        shipmentRef: normalized.shipmentRef,
        courierCode: normalized.courierCode
      },
      idempotency: {
        topupIntent: topupIntent.idempotent,
        topupConfirmation: topupConfirmation.idempotent,
        hold: hold.idempotent,
        capture: capture.idempotent,
        refund: refund.idempotent
      },
      steps: {
        topupIntentId: topupIntent.intent.id,
        topupJournalEntryId: topupConfirmation.journalEntryId,
        holdId: hold.hold.id,
        holdStatusAfterCapture: "captured",
        captureJournalEntryId: capture.journalEntryId,
        refundJournalEntryId: refund.journalEntryId,
        refundMode: "wallet_only"
      },
      summaries: {
        afterTopup: summaryAfterTopup,
        afterCapture: summaryAfterCapture,
        final: finalSummary
      },
      statement,
      blockers
    };
  }
}

export const w1SandboxSmokeService = new W1SandboxSmokeService();

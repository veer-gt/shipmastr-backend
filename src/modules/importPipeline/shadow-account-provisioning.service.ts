import {
  defaultAccountTypeConfigs,
  ledgerService,
  LedgerService,
  type LedgerAccountClass,
  type LedgerAccountType,
  type LedgerOwnerType,
  type LedgerScope
} from "../walletLedger/ledger.service.js";
import { ImportPipelineError } from "./import-pipeline.errors.js";
import { W0C1_SHADOW_ACCOUNT_TYPES, type ShadowLedgerAccountSet } from "./shadow-ledger-mapper.js";

type WalletOwnerRecord = {
  id: string;
  ownerType: LedgerOwnerType;
  externalId?: string | null;
  displayName?: string | null;
};

type WalletAccountRecord = {
  id: string;
  ownerId: string;
  ownerType: LedgerOwnerType;
  accountType: LedgerAccountType;
  accountClass: LedgerAccountClass;
  status: string;
  ledgerScope: LedgerScope;
  currency: string;
};

type AccountTypeConfigRecord = {
  accountType: LedgerAccountType;
  accountClass: LedgerAccountClass;
  allowedOwnerTypes: LedgerOwnerType[];
  allowedLedgerScopes: LedgerScope[];
};

type AccountBalanceRecord = {
  accountId: string;
  balancePaise: bigint;
};

type ShadowProvisioningClient = {
  accountTypeConfig: {
    findUnique(input: { where: { accountType: LedgerAccountType } }): Promise<AccountTypeConfigRecord | null>;
  };
  walletOwner: {
    findUnique(input: { where: { ownerType_externalId: { ownerType: LedgerOwnerType; externalId: string } } }): Promise<WalletOwnerRecord | null>;
  };
  walletAccount: {
    findFirst(input: { where: Record<string, unknown> }): Promise<WalletAccountRecord | null>;
  };
  accountBalance: {
    findMany(input: { where: Record<string, unknown> }): Promise<AccountBalanceRecord[]>;
  };
};

type ImportFileOwnerContext = {
  id: string;
  brandOrgId?: string | null;
  counterparty?: string | null;
};

export type ProvisionedShadowAccounts = {
  sellerOwner: WalletOwnerRecord;
  courierOwner: WalletOwnerRecord;
  accounts: ShadowLedgerAccountSet;
};

function cleanRequired(value: unknown, code: string) {
  const text = String(value ?? "").trim();
  if (!text) throw new ImportPipelineError(code, code);
  return text;
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "P2002");
}

function fallbackConfig(accountType: LedgerAccountType) {
  return defaultAccountTypeConfigs.find((config) => config.accountType === accountType) ?? null;
}

function allowedForW0C(ownerType: LedgerOwnerType, accountType: LedgerAccountType) {
  const allowed = W0C1_SHADOW_ACCOUNT_TYPES[ownerType as "seller" | "courier"];
  return Boolean(allowed?.includes(accountType));
}

export class ShadowAccountProvisioningService {
  constructor(
    private readonly client: ShadowProvisioningClient,
    private readonly ledger: LedgerService = ledgerService
  ) {}

  async ensureAccountsForImportFile(file: ImportFileOwnerContext): Promise<ProvisionedShadowAccounts> {
    const sellerOwner = await this.ensureOwner({
      ownerType: "seller",
      externalId: cleanRequired(file.brandOrgId, "SELLER_OWNER_REQUIRED"),
      displayName: "W0 shadow seller"
    });
    const courierOwner = await this.ensureOwner({
      ownerType: "courier",
      externalId: cleanRequired(file.counterparty, "COURIER_OWNER_REQUIRED"),
      displayName: "W0 shadow courier"
    });

    const shippingBalance = await this.ensureShadowAccount(sellerOwner, "shipping_balance");
    const codReceivable = await this.ensureShadowAccount(sellerOwner, "cod_receivable");
    const disputeHold = await this.ensureShadowAccount(sellerOwner, "dispute_hold");
    const courierPayable = await this.ensureShadowAccount(courierOwner, "courier_payable");
    const courierCodDue = await this.ensureShadowAccount(courierOwner, "courier_cod_due");

    return {
      sellerOwner,
      courierOwner,
      accounts: {
        seller: {
          shippingBalance: shippingBalance.id,
          codReceivable: codReceivable.id,
          disputeHold: disputeHold.id
        },
        courier: {
          courierPayable: courierPayable.id,
          courierCodDue: courierCodDue.id
        }
      }
    };
  }

  async findAccountsForImportFile(file: ImportFileOwnerContext): Promise<ProvisionedShadowAccounts> {
    const sellerOwner = await this.findOwner({
      ownerType: "seller",
      externalId: cleanRequired(file.brandOrgId, "SELLER_OWNER_REQUIRED")
    });
    const courierOwner = await this.findOwner({
      ownerType: "courier",
      externalId: cleanRequired(file.counterparty, "COURIER_OWNER_REQUIRED")
    });

    const shippingBalance = await this.findShadowAccount(sellerOwner, "shipping_balance");
    const codReceivable = await this.findShadowAccount(sellerOwner, "cod_receivable");
    const disputeHold = await this.findShadowAccount(sellerOwner, "dispute_hold");
    const courierPayable = await this.findShadowAccount(courierOwner, "courier_payable");
    const courierCodDue = await this.findShadowAccount(courierOwner, "courier_cod_due");

    return {
      sellerOwner,
      courierOwner,
      accounts: {
        seller: {
          shippingBalance: shippingBalance.id,
          codReceivable: codReceivable.id,
          disputeHold: disputeHold.id
        },
        courier: {
          courierPayable: courierPayable.id,
          courierCodDue: courierCodDue.id
        }
      }
    };
  }

  async ensureOwner(input: { ownerType: LedgerOwnerType; externalId: string; displayName: string }) {
    return this.ledger.createOwner({
      ownerType: input.ownerType,
      externalId: input.externalId,
      displayName: input.displayName,
      metadata: { source: "w0c1_shadow_import" }
    });
  }

  async findOwner(input: { ownerType: LedgerOwnerType; externalId: string }) {
    const owner = await this.client.walletOwner.findUnique({
      where: { ownerType_externalId: { ownerType: input.ownerType, externalId: input.externalId } }
    });
    if (!owner) {
      throw new ImportPipelineError("ACCOUNT_PROVISIONING_FAILED", "ACCOUNT_PROVISIONING_FAILED", {
        ownerType: input.ownerType
      });
    }
    return owner;
  }

  private async validateShadowAccountConfig(owner: WalletOwnerRecord, accountType: LedgerAccountType) {
    if (!allowedForW0C(owner.ownerType, accountType)) {
      throw new ImportPipelineError("SHADOW_ACCOUNT_TYPE_NOT_ALLOWED_FOR_W0C", "SHADOW_ACCOUNT_TYPE_NOT_ALLOWED_FOR_W0C", {
        ownerType: owner.ownerType,
        accountType
      });
    }

    const config = await this.client.accountTypeConfig.findUnique({ where: { accountType } }) ?? fallbackConfig(accountType);
    if (!config) throw new ImportPipelineError("ACCOUNT_PROVISIONING_FAILED", "ACCOUNT_PROVISIONING_FAILED", { accountType });
    if (!config.allowedOwnerTypes.includes(owner.ownerType)) {
      throw new ImportPipelineError("ACCOUNT_PROVISIONING_FAILED", "ACCOUNT_PROVISIONING_FAILED", { accountType, ownerType: owner.ownerType });
    }
    if (!config.allowedLedgerScopes.includes("shadow")) {
      throw new ImportPipelineError("ACCOUNT_PROVISIONING_FAILED", "ACCOUNT_PROVISIONING_FAILED", { accountType, ledgerScope: "shadow" });
    }
    return config;
  }

  async findShadowAccount(owner: WalletOwnerRecord, accountType: LedgerAccountType) {
    const config = await this.validateShadowAccountConfig(owner, accountType);

    const existing = await this.client.walletAccount.findFirst({
      where: {
        ownerId: owner.id,
        accountType,
        ledgerScope: "shadow",
        currency: "INR"
      }
    });
    if (!existing) throw new ImportPipelineError("ACCOUNT_PROVISIONING_FAILED", "ACCOUNT_PROVISIONING_FAILED", { accountType });
    if (existing.accountClass !== config.accountClass) {
      throw new ImportPipelineError("ACCOUNT_PROVISIONING_FAILED", "ACCOUNT_PROVISIONING_FAILED", { accountType, accountClass: existing.accountClass });
    }
    return existing;
  }

  async ensureShadowAccount(owner: WalletOwnerRecord, accountType: LedgerAccountType) {
    await this.validateShadowAccountConfig(owner, accountType);

    const existing = await this.client.walletAccount.findFirst({
      where: {
        ownerId: owner.id,
        accountType,
        ledgerScope: "shadow",
        currency: "INR"
      }
    });
    if (existing) return existing;

    try {
      return await this.ledger.createAccount({
        ownerId: owner.id,
        ownerType: owner.ownerType,
        accountType,
        ledgerScope: "shadow",
        currency: "INR",
        status: "active",
        label: `W0 shadow ${accountType}`,
        metadata: { source: "w0c1_shadow_import" }
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const recovered = await this.client.walletAccount.findFirst({
        where: {
          ownerId: owner.id,
          accountType,
          ledgerScope: "shadow",
          currency: "INR"
        }
      });
      if (recovered) return recovered;
      throw error;
    }
  }

  async getBalancePaise(accountId: string) {
    const balances = await this.client.accountBalance.findMany({ where: { accountId } });
    return balances[0]?.balancePaise ?? 0n;
  }
}

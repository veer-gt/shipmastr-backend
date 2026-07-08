import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import bcrypt from "bcryptjs";

type BootstrapModule = {
  STAGING_BOOTSTRAP_APPROVAL: string;
  STAGING_MASTER_ADMIN_EMAIL: string;
  STAGING_MASTER_ADMIN_ROLE: string;
  STAGING_MASTER_ADMIN_USER_TYPE: string;
  assertStagingAdminBootstrapSafety(source: Record<string, string | undefined>): void;
  sanitizeBootstrapErrorMessage(error: unknown): string;
  bootstrapStagingMasterAdmin(input: {
    client: unknown;
    source: Record<string, string | undefined>;
    hashPassword?: (password: string) => Promise<string>;
  }): Promise<{
    action: string;
    email: string;
    userId: string;
    merchantId: string;
    role: string;
    userType: string;
    stagingOnly: boolean;
  }>;
};

async function loadBootstrapModule(): Promise<BootstrapModule> {
  return import(pathToFileURL(join(process.cwd(), "scripts/bootstrap-staging-master-admin.mjs")).href) as Promise<BootstrapModule>;
}

const safeEnv = {
  SHIPMASTR_STAGING_ADMIN_BOOTSTRAP_APPROVAL: "APPROVE_STAGING_ONLY_MASTER_ADMIN_USER_CREATION",
  TARGET_ENV: "staging",
  APP_ENV: "staging",
  ADMIN_EMAIL: "indraveer.chauhan@gmail.com",
  DATABASE_URL: "postgresql://shipmastr:shipmastr@127.0.0.1:5432/shipmastr_staging",
  DATABASE_URL_REF: "DATABASE_URL_STAGING",
  STAGING_MASTER_ADMIN_PASSWORD: "staging-test-password-only"
};

function makeClient(existingUser = false) {
  const calls: {
    merchantUpsert: any[];
    userFindUnique: any[];
    userUpsert: any[];
  } = {
    merchantUpsert: [],
    userFindUnique: [],
    userUpsert: []
  };

  return {
    calls,
    client: {
      merchant: {
        upsert: async (args: any) => {
          calls.merchantUpsert.push(args);
          return { id: "merchant_staging_admin", email: args.where.email };
        }
      },
      user: {
        findUnique: async (args: any) => {
          calls.userFindUnique.push(args);
          return existingUser ? { id: "user_staging_admin" } : null;
        },
        upsert: async (args: any) => {
          calls.userUpsert.push(args);
          return {
            id: "user_staging_admin",
            email: args.where.email,
            merchantId: args.update.merchantId,
            role: args.update.role,
            userType: args.update.userType
          };
        }
      }
    }
  };
}

describe("staging master admin bootstrap utility", () => {
  it("requires exact staging-only approval and target env", async () => {
    const bootstrap = await loadBootstrapModule();

    assert.throws(
      () => bootstrap.assertStagingAdminBootstrapSafety({ ...safeEnv, SHIPMASTR_STAGING_ADMIN_BOOTSTRAP_APPROVAL: "yes" }),
      /exactly approve/
    );
    assert.throws(
      () => bootstrap.assertStagingAdminBootstrapSafety({ ...safeEnv, TARGET_ENV: "production" }),
      /TARGET_ENV/
    );
  });

  it("requires the reviewed owner email and a non-empty staging password", async () => {
    const bootstrap = await loadBootstrapModule();

    assert.throws(
      () => bootstrap.assertStagingAdminBootstrapSafety({ ...safeEnv, ADMIN_EMAIL: "ops-admin@shipmastr.test" }),
      /ADMIN_EMAIL/
    );
    assert.throws(
      () => bootstrap.assertStagingAdminBootstrapSafety({ ...safeEnv, STAGING_MASTER_ADMIN_PASSWORD: "short" }),
      /STAGING_MASTER_ADMIN_PASSWORD/
    );
  });

  it("requires a staging database identifier and rejects production identifiers", async () => {
    const bootstrap = await loadBootstrapModule();

    assert.throws(
      () => bootstrap.assertStagingAdminBootstrapSafety({ ...safeEnv, DATABASE_URL: "postgresql://user:pass@localhost:5432/shipmastr", DATABASE_URL_REF: "" }),
      /DATABASE_URL_STAGING/
    );
    assert.throws(
      () => bootstrap.assertStagingAdminBootstrapSafety({ ...safeEnv, DATABASE_URL_REF: "DATABASE_URL" }),
      /production DATABASE_URL/
    );
    assert.throws(
      () => bootstrap.assertStagingAdminBootstrapSafety({ ...safeEnv, DATABASE_URL_REF: "DATABASE_URL_PRODUCTION" }),
      /production database identifier/
    );
  });

  it("allows Cloud Run jobs only for explicit staging bootstrap and refuses live services", async () => {
    const bootstrap = await loadBootstrapModule();

    assert.doesNotThrow(
      () => bootstrap.assertStagingAdminBootstrapSafety({ ...safeEnv, CLOUD_RUN_JOB: "shipmastr-staging-admin-bootstrap" })
    );
    assert.throws(
      () => bootstrap.assertStagingAdminBootstrapSafety({ ...safeEnv, K_SERVICE: "shipmastr-api-staging" }),
      /live Cloud Run service/
    );
  });

  it("creates a staging internal MASTER_ADMIN with login-compatible password hash", async () => {
    const bootstrap = await loadBootstrapModule();
    const state = makeClient(false);

    const result = await bootstrap.bootstrapStagingMasterAdmin({
      client: state.client,
      source: safeEnv,
      hashPassword: (password) => bcrypt.hash(password, 4)
    });
    const userUpsert = state.calls.userUpsert[0];
    const passwordHash = userUpsert.create.passwordHash;

    assert.equal(result.action, "created");
    assert.equal(result.email, bootstrap.STAGING_MASTER_ADMIN_EMAIL);
    assert.equal(result.role, bootstrap.STAGING_MASTER_ADMIN_ROLE);
    assert.equal(result.userType, bootstrap.STAGING_MASTER_ADMIN_USER_TYPE);
    assert.equal(result.stagingOnly, true);
    assert.equal(state.calls.merchantUpsert[0].where.email, bootstrap.STAGING_MASTER_ADMIN_EMAIL);
    assert.equal(userUpsert.create.email, bootstrap.STAGING_MASTER_ADMIN_EMAIL);
    assert.equal(userUpsert.create.role, bootstrap.STAGING_MASTER_ADMIN_ROLE);
    assert.equal(userUpsert.create.userType, bootstrap.STAGING_MASTER_ADMIN_USER_TYPE);
    assert.equal(userUpsert.update.role, bootstrap.STAGING_MASTER_ADMIN_ROLE);
    assert.equal(userUpsert.update.userType, bootstrap.STAGING_MASTER_ADMIN_USER_TYPE);
    assert.equal(await bcrypt.compare(safeEnv.STAGING_MASTER_ADMIN_PASSWORD, passwordHash), true);
  });

  it("updates an existing staging admin without returning password material", async () => {
    const bootstrap = await loadBootstrapModule();
    const state = makeClient(true);

    const result = await bootstrap.bootstrapStagingMasterAdmin({
      client: state.client,
      source: safeEnv,
      hashPassword: async () => "hash:redacted"
    });

    assert.equal(result.action, "updated");
    assert.equal(state.calls.userUpsert[0].update.passwordHash, "hash:redacted");
    assert.equal("passwordHash" in result, false);
  });

  it("redacts sensitive values from bootstrap error output", async () => {
    const bootstrap = await loadBootstrapModule();
    const redacted = bootstrap.sanitizeBootstrapErrorMessage(
      new Error('passwordHash: "$2b$12$rVsSGq/H.LF1HZmBy4bPduRVLoWhMSOT.7KC3X/xvy6N9DHq05Zoi" postgresql://user:pass@host/db')
    );

    assert.doesNotMatch(redacted, /\$2b\$12\$/);
    assert.doesNotMatch(redacted, /postgresql:\/\/user:pass/);
    assert.match(redacted, /\[redacted-password-hash\]/);
    assert.match(redacted, /\[redacted-database-url\]/);
  });
});

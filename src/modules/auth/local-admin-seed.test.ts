import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import bcrypt from "bcryptjs";

type SeedModule = {
  LOCAL_ADMIN_EMAIL: string;
  LOCAL_ADMIN_MERCHANT_ID: string;
  LOCAL_ADMIN_ROLE: string;
  LOCAL_ADMIN_USER_TYPE: string;
  assertLocalAdminSeedSafety(source: Record<string, string | undefined>): void;
  seedLocalAdmin(input: {
    client: unknown;
    source: Record<string, string | undefined>;
    hashPassword?: (password: string) => Promise<string>;
  }): Promise<{ email: string; action: string; localOnly: boolean }>;
};

async function loadSeedModule(): Promise<SeedModule> {
  return import(pathToFileURL(join(process.cwd(), "scripts/seed-local-admin.mjs")).href) as Promise<SeedModule>;
}

const safeEnv = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://shipmastr:shipmastr@localhost:5432/shipmastr_local",
  LOCAL_ADMIN_PASSWORD: "local-test-password-only"
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
          return { id: args.where.id };
        }
      },
      user: {
        findUnique: async (args: any) => {
          calls.userFindUnique.push(args);
          return existingUser ? { id: "user_local_admin" } : null;
        },
        upsert: async (args: any) => {
          calls.userUpsert.push(args);
          return { id: "user_local_admin" };
        }
      }
    }
  };
}

describe("local admin seed utility", () => {
  it("refuses production runtime settings", async () => {
    const seed = await loadSeedModule();

    assert.throws(
      () => seed.assertLocalAdminSeedSafety({ ...safeEnv, NODE_ENV: "production" }),
      /NODE_ENV=production/
    );
    assert.throws(
      () => seed.assertLocalAdminSeedSafety({ ...safeEnv, K_SERVICE: "shipmastr-api" }),
      /Cloud Run/
    );
  });

  it("refuses missing LOCAL_ADMIN_PASSWORD", async () => {
    const seed = await loadSeedModule();

    assert.throws(
      () => seed.assertLocalAdminSeedSafety({ NODE_ENV: "development", DATABASE_URL: safeEnv.DATABASE_URL }),
      /LOCAL_ADMIN_PASSWORD/
    );
  });

  it("refuses production-looking DATABASE_URL values", async () => {
    const seed = await loadSeedModule();

    for (const databaseUrl of [
      "postgresql://user:pass@localhost:5432/shipmastr_prod",
      "postgresql://user:pass@/db?host=/cloudsql/shipmastr-core-prod:asia-south1:db",
      "postgresql://user:pass@asia-south1.example.internal:5432/db"
    ]) {
      assert.throws(
        () => seed.assertLocalAdminSeedSafety({ ...safeEnv, DATABASE_URL: databaseUrl }),
        /production-looking DATABASE_URL/
      );
    }
  });

  it("creates a local internal MASTER_ADMIN with login-compatible password hash", async () => {
    const seed = await loadSeedModule();
    const state = makeClient(false);

    const result = await seed.seedLocalAdmin({
      client: state.client,
      source: safeEnv,
      hashPassword: (password) => bcrypt.hash(password, 4)
    });
    const userUpsert = state.calls.userUpsert[0];
    const passwordHash = userUpsert.create.passwordHash;

    assert.equal(result.email, seed.LOCAL_ADMIN_EMAIL);
    assert.equal(result.action, "created");
    assert.equal(result.localOnly, true);
    assert.equal(state.calls.merchantUpsert[0].where.id, seed.LOCAL_ADMIN_MERCHANT_ID);
    assert.equal(userUpsert.create.email, seed.LOCAL_ADMIN_EMAIL);
    assert.equal(userUpsert.create.role, seed.LOCAL_ADMIN_ROLE);
    assert.equal(userUpsert.create.userType, seed.LOCAL_ADMIN_USER_TYPE);
    assert.equal(userUpsert.update.role, seed.LOCAL_ADMIN_ROLE);
    assert.equal(userUpsert.update.userType, seed.LOCAL_ADMIN_USER_TYPE);
    assert.equal(await bcrypt.compare(safeEnv.LOCAL_ADMIN_PASSWORD, passwordHash), true);
  });

  it("updates an existing local admin without exposing password material", async () => {
    const seed = await loadSeedModule();
    const state = makeClient(true);

    const result = await seed.seedLocalAdmin({
      client: state.client,
      source: safeEnv,
      hashPassword: async () => "hash:redacted"
    });

    assert.equal(result.action, "updated");
    assert.equal(state.calls.userUpsert[0].update.passwordHash, "hash:redacted");
  });
});

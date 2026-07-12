import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;
type AuthAbuseModel = {
  findUnique(input: unknown): Promise<any>;
  upsert(input: unknown): Promise<any>;
  update(input: unknown): Promise<any>;
  deleteMany(input: unknown): Promise<unknown>;
};

type AuthAbuseRow = {
  id: string;
  scopeKey: string;
  routeClass: string;
  windowStart: Date;
  attempts: number;
  lockUntil: Date | null;
  notificationSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type RawQueryClient = {
  $queryRaw<T>(query: unknown): Promise<T>;
};

export const AUTH_ABUSE_POLICY = Object.freeze({
  routeClass: "login",
  windowMs: 15 * 60 * 1000,
  networkLimit: 20,
  accountLockThreshold: 8,
  lockMs: 15 * 60 * 1000,
  delayStartAttempt: 3,
  delayBaseMs: 1000,
  delayCapMs: 30 * 1000,
  notificationSuppressionMs: 15 * 60 * 1000
});

function model(client: Db): AuthAbuseModel {
  return (client as unknown as { authAbuseState: AuthAbuseModel }).authAbuseState;
}

function windowStart(now: Date) {
  return new Date(Math.floor(now.getTime() / AUTH_ABUSE_POLICY.windowMs) * AUTH_ABUSE_POLICY.windowMs);
}

export function hashAuthScope(scope: string) {
  return createHash("sha256")
    .update(`${env.APP_SECRET_PEPPER}:auth-abuse:${scope}`)
    .digest("hex");
}

export function accountScope(identifier: string) {
  return hashAuthScope(`account:${identifier.trim().toLowerCase()}`);
}

export function networkScope(networkKey: string) {
  return hashAuthScope(`network:${networkKey}`);
}

function activeState(state: any, now: Date) {
  if (!state || new Date(state.windowStart).getTime() < windowStart(now).getTime()) return null;
  return state;
}

function rawQueryClient(client: Db) {
  const candidate = client as unknown as Partial<RawQueryClient>;
  return typeof candidate.$queryRaw === "function" ? candidate as RawQueryClient : null;
}

function mapAuthAbuseRow(row: Record<string, unknown>): AuthAbuseRow {
  return {
    id: String(row.id),
    scopeKey: String(row.scopeKey),
    routeClass: String(row.routeClass),
    windowStart: new Date(String(row.windowStart)),
    attempts: Number(row.attempts),
    lockUntil: row.lockUntil ? new Date(String(row.lockUntil)) : null,
    notificationSentAt: row.notificationSentAt ? new Date(String(row.notificationSentAt)) : null,
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt))
  };
}

export function delayForAttempts(attempts: number) {
  if (attempts < AUTH_ABUSE_POLICY.delayStartAttempt) return 0;
  const exponent = Math.max(0, attempts - AUTH_ABUSE_POLICY.delayStartAttempt);
  return Math.min(
    AUTH_ABUSE_POLICY.delayCapMs,
    AUTH_ABUSE_POLICY.delayBaseMs * (2 ** exponent)
  );
}

async function incrementScope(client: Db, scopeKey: string, routeClass: string, now: Date) {
  const raw = rawQueryClient(client);
  if (raw) {
    const rows = await raw.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      INSERT INTO "auth_abuse_states" ("id", "scope_key", "route_class", "window_start", "attempts", "updated_at")
      VALUES (${randomUUID()}, ${scopeKey}, ${routeClass}, ${windowStart(now)}, 1, CURRENT_TIMESTAMP)
      ON CONFLICT ("scope_key") DO UPDATE SET
        "route_class" = EXCLUDED."route_class",
        "window_start" = CASE
          WHEN "auth_abuse_states"."window_start" < EXCLUDED."window_start" THEN EXCLUDED."window_start"
          ELSE "auth_abuse_states"."window_start"
        END,
        "attempts" = CASE
          WHEN "auth_abuse_states"."window_start" < EXCLUDED."window_start" THEN 1
          ELSE "auth_abuse_states"."attempts" + 1
        END,
        "lock_until" = CASE
          WHEN "auth_abuse_states"."window_start" < EXCLUDED."window_start" THEN NULL
          ELSE "auth_abuse_states"."lock_until"
        END,
        "notification_sent_at" = CASE
          WHEN "auth_abuse_states"."window_start" < EXCLUDED."window_start" THEN NULL
          ELSE "auth_abuse_states"."notification_sent_at"
        END,
        "updated_at" = CURRENT_TIMESTAMP
      RETURNING
        "id", "scope_key" AS "scopeKey", "route_class" AS "routeClass",
        "window_start" AS "windowStart", "attempts", "lock_until" AS "lockUntil",
        "notification_sent_at" AS "notificationSentAt", "created_at" AS "createdAt",
        "updated_at" AS "updatedAt"
    `);
    if (!rows[0]) throw new Error("Auth abuse state upsert returned no row");
    return mapAuthAbuseRow(rows[0]);
  }
  const authAbuseState = model(client);
  const current = activeState(await authAbuseState.findUnique({ where: { scopeKey } }), now);
  if (!current) {
    try {
      return await authAbuseState.upsert({
        where: { scopeKey },
        create: {
          scopeKey,
          routeClass,
          windowStart: windowStart(now),
          attempts: 1
        },
        update: {
          routeClass,
          windowStart: windowStart(now),
          attempts: 1,
          lockUntil: null,
          notificationSentAt: null
        }
      });
    } catch {
      // A concurrent first request may win the unique insert. The follow-up
      // increment is atomic and preserves both failures.
      return authAbuseState.update({
        where: { scopeKey },
        data: { attempts: { increment: 1 } }
      });
    }
  }

  return authAbuseState.update({
    where: { scopeKey },
    data: { attempts: { increment: 1 } }
  });
}

export async function getAuthAbuseStatus(input: {
  accountKey: string;
  networkKey: string;
  now?: Date;
  client?: Db;
}) {
  const now = input.now ?? new Date();
  const client = input.client ?? prisma;
  const authAbuseState = model(client);
  const [account, network] = await Promise.all([
    authAbuseState.findUnique({ where: { scopeKey: accountScope(input.accountKey) } }),
    authAbuseState.findUnique({ where: { scopeKey: networkScope(input.networkKey) } })
  ]);
  const activeAccount = activeState(account, now);
  const activeNetwork = activeState(network, now);
  const locked = Boolean(activeAccount?.lockUntil && new Date(activeAccount.lockUntil).getTime() > now.getTime());
  const networkBlocked = Number(activeNetwork?.attempts ?? 0) >= AUTH_ABUSE_POLICY.networkLimit;
  return {
    blocked: locked || networkBlocked,
    locked,
    networkBlocked,
    delayMs: delayForAttempts(Number(activeAccount?.attempts ?? 0)),
    accountAttempts: Number(activeAccount?.attempts ?? 0),
    networkAttempts: Number(activeNetwork?.attempts ?? 0)
  };
}

export async function recordAuthFailure(input: {
  accountKey: string;
  networkKey: string;
  now?: Date;
  client?: Db;
}) {
  const now = input.now ?? new Date();
  const client = input.client ?? prisma;
  const run = async (tx: Db) => {
    const [network, account] = await Promise.all([
      incrementScope(tx, networkScope(input.networkKey), AUTH_ABUSE_POLICY.routeClass, now),
      incrementScope(tx, accountScope(input.accountKey), AUTH_ABUSE_POLICY.routeClass, now)
    ]);
    const accountWasLocked = Boolean(account.lockUntil && new Date(account.lockUntil).getTime() > now.getTime());
    let accountState = account;
    let shouldNotify = false;
    if (account.attempts >= AUTH_ABUSE_POLICY.accountLockThreshold && !accountWasLocked) {
      const raw = rawQueryClient(tx);
      if (raw) {
        const lockedRows = await raw.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          UPDATE "auth_abuse_states"
          SET "lock_until" = ${new Date(now.getTime() + AUTH_ABUSE_POLICY.lockMs)},
              "notification_sent_at" = NULL,
              "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${account.id}
            AND ("lock_until" IS NULL OR "lock_until" <= ${now})
          RETURNING
            "id", "scope_key" AS "scopeKey", "route_class" AS "routeClass",
            "window_start" AS "windowStart", "attempts", "lock_until" AS "lockUntil",
            "notification_sent_at" AS "notificationSentAt", "created_at" AS "createdAt",
            "updated_at" AS "updatedAt"
        `);
        if (lockedRows[0]) {
          accountState = mapAuthAbuseRow(lockedRows[0]);
          shouldNotify = true;
        } else {
          accountState = await model(tx).findUnique({ where: { id: account.id } }) ?? account;
        }
      } else {
        accountState = await model(tx).update({
          where: { id: account.id },
          data: {
            lockUntil: new Date(now.getTime() + AUTH_ABUSE_POLICY.lockMs),
            notificationSentAt: null
          }
        });
        shouldNotify = true;
      }
    }
    return {
      blocked: Boolean(shouldNotify || (accountState.lockUntil && new Date(accountState.lockUntil).getTime() > now.getTime()) || network.attempts >= AUTH_ABUSE_POLICY.networkLimit),
      locked: Boolean(accountState.lockUntil && new Date(accountState.lockUntil).getTime() > now.getTime()),
      networkBlocked: network.attempts >= AUTH_ABUSE_POLICY.networkLimit,
      delayMs: delayForAttempts(account.attempts),
      shouldNotify,
      accountAttempts: account.attempts,
      networkAttempts: network.attempts
    };
  };
  const transactionClient = client as typeof prisma;
  if (typeof transactionClient.$transaction === "function") {
    return transactionClient.$transaction(async (tx) => run(tx));
  }
  return run(client);
}

export async function resetAuthAccountFailures(accountKey: string, client: Db = prisma) {
  await model(client).deleteMany({ where: { scopeKey: accountScope(accountKey) } });
}

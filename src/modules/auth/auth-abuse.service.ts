import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;
type AuthAbuseModel = {
  findUnique(input: unknown): Promise<any>;
  upsert(input: unknown): Promise<any>;
  update(input: unknown): Promise<any>;
  deleteMany(input: unknown): Promise<unknown>;
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

export function delayForAttempts(attempts: number) {
  if (attempts < AUTH_ABUSE_POLICY.delayStartAttempt) return 0;
  const exponent = Math.max(0, attempts - AUTH_ABUSE_POLICY.delayStartAttempt);
  return Math.min(
    AUTH_ABUSE_POLICY.delayCapMs,
    AUTH_ABUSE_POLICY.delayBaseMs * (2 ** exponent)
  );
}

async function incrementScope(client: Db, scopeKey: string, routeClass: string, now: Date) {
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
      accountState = await model(tx).update({
        where: { id: account.id },
        data: {
          lockUntil: new Date(now.getTime() + AUTH_ABUSE_POLICY.lockMs),
          notificationSentAt: null
        }
      });
      shouldNotify = true;
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

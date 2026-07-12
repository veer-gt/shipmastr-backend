import bcrypt from "bcryptjs";

export const PASSWORD_BCRYPT_COST = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const DUMMY_PASSWORD_HASH = "$2b$12$ZdlZlmPxOEVVTu1Ly832.uqEyWbJAiVxL694y.oQ8yHPsIUNs7IRW";

export function passwordHashNeedsRehash(passwordHash: string) {
  if (!/^\$2[aby]\$\d{2}\$/.test(passwordHash)) return true;
  try {
    return bcrypt.getRounds(passwordHash) < PASSWORD_BCRYPT_COST;
  } catch {
    return true;
  }
}

export function hashPassword(password: string) {
  return bcrypt.hash(password, PASSWORD_BCRYPT_COST);
}

export async function verifyPassword(password: string, passwordHash: string) {
  try {
    return await bcrypt.compare(password, passwordHash);
  } catch {
    return false;
  }
}

export async function verifyPasswordAndMaybeRehash(password: string, passwordHash: string) {
  const valid = await verifyPassword(password, passwordHash);
  return {
    valid,
    replacementHash: valid && passwordHashNeedsRehash(passwordHash)
      ? await hashPassword(password)
      : null
  };
}

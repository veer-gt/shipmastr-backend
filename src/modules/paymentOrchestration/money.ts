const MAX_BIGINT = 9_223_372_036_854_775_807n;

export function parseInrPaise(text: string): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error('INVALID_INR_AMOUNT');
  const paise = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (paise < 1n || paise > MAX_BIGINT) throw new Error('INVALID_INR_AMOUNT');
  return paise;
}

export const PGO1_MAX_BIGINT_PAISE = MAX_BIGINT;

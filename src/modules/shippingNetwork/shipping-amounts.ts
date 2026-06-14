export function parseAmountToPaise(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return 0;

  const value = String(raw)
    .replace(/₹/g, "")
    .replace(/,/g, "")
    .trim();
  const parsed = Number.parseFloat(value);

  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 100);
}

export function paiseToRupees(paise: number): string {
  return (paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export function paiseToExistingOrderAmount(paise: number): number {
  return Math.round(paise / 100);
}

export function existingOrderAmountToPaise(amount: number | null | undefined): number {
  return Math.max(0, Math.round(Number(amount ?? 0) * 100));
}

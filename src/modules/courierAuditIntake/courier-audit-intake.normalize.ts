import type {
  CourierAuditIntakeRequest,
  CourierAuditNormalizedProjection,
  CourierAuditWarning
} from "./courier-audit-intake.contract.js";

type Extraction = CourierAuditIntakeRequest["extraction"];

const canonicalizeWhitespace = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return value.trim().replace(/\s+/gu, " ");
};

const normalizedEmail = (value: string | null | undefined): string | null => {
  const email = canonicalizeWhitespace(value);
  if (email === null || !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/iu.test(email)) {
    return null;
  }

  return email.toLowerCase();
};

const normalizedIndianPhone = (value: string | null | undefined): string | null => {
  const phone = canonicalizeWhitespace(value);
  if (phone === null) {
    return null;
  }

  const match = /^(?:\+91|91)?(\d{10})$/u.exec(phone);
  return match ? `+91${match[1]}` : null;
};

const normalizedCurrency = (value: string | null | undefined): string | null => {
  const currency = canonicalizeWhitespace(value);
  if (currency === null || !/^[A-Za-z]{3}$/u.test(currency)) {
    return null;
  }

  return currency.toUpperCase();
};

const normalizeInrMinorUnits = (value: string): string | null => {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/u.exec(value.trim());
  if (!match) {
    return null;
  }

  const fractional = (match[2] ?? "").padEnd(2, "0");
  return `${match[1]}${fractional}`.replace(/^0+(?=\d)/u, "");
};

const appendWarning = (warnings: CourierAuditWarning[], warning: CourierAuditWarning): void => {
  if (warnings.length < 50) {
    warnings.push(warning);
  }
};

export function normalizeCourierAuditExtraction(input: Extraction): {
  normalizedProjection: CourierAuditNormalizedProjection;
  warnings: CourierAuditWarning[];
} {
  const warnings = input.warnings.map((warning) => ({ ...warning }));
  const { result } = input;
  const contactEmail = normalizedEmail(result.contactEmail);
  const contactPhoneE164 = normalizedIndianPhone(result.contactPhone);
  const currency = normalizedCurrency(result.currency);

  if (result.contactEmail !== null && result.contactEmail !== undefined && contactEmail === null) {
    appendWarning(warnings, {
      code: "INVALID_CONTACT_EMAIL",
      message: "Contact email could not be normalized deterministically.",
      field: "contactEmail"
    });
  }

  if (result.contactPhone !== null && result.contactPhone !== undefined && contactPhoneE164 === null) {
    appendWarning(warnings, {
      code: "AMBIGUOUS_CONTACT_PHONE",
      message: "Contact phone could not be normalized deterministically.",
      field: "contactPhone"
    });
  }

  if (result.currency !== null && result.currency !== undefined && currency === null) {
    appendWarning(warnings, {
      code: "INVALID_CURRENCY",
      message: "Currency could not be normalized deterministically.",
      field: "currency"
    });
  }

  let totalBilledMinorUnits: string | null = null;
  if (result.totalBilledAmount !== null && result.totalBilledAmount !== undefined) {
    if (currency === "INR") {
      totalBilledMinorUnits = normalizeInrMinorUnits(result.totalBilledAmount);
      if (totalBilledMinorUnits === null) {
        appendWarning(warnings, {
          code: "INVALID_INR_AMOUNT",
          message: "Billed amount could not be normalized to INR minor units deterministically.",
          field: "totalBilledAmount"
        });
      }
    } else if (currency === null && (result.currency === null || result.currency === undefined)) {
      appendWarning(warnings, {
        code: "MISSING_CURRENCY_MINOR_UNIT_NORMALIZATION",
        message: "Billed amount could not be normalized because currency is missing.",
        field: "totalBilledAmount"
      });
    } else if (currency !== null) {
      appendWarning(warnings, {
        code: "UNSUPPORTED_CURRENCY_MINOR_UNIT_NORMALIZATION",
        message: "Minor-unit normalization is supported only for INR in V1.",
        field: "totalBilledAmount"
      });
    }
  }

  return {
    normalizedProjection: {
      companyName: canonicalizeWhitespace(result.companyName),
      contactName: canonicalizeWhitespace(result.contactName),
      contactEmail,
      contactPhoneE164,
      courierName: canonicalizeWhitespace(result.courierName),
      documentKinds: [...result.documentKinds],
      invoiceNumbers: result.invoiceNumbers.map((value) => canonicalizeWhitespace(value) ?? ""),
      billingPeriodStart: result.billingPeriodStart ?? null,
      billingPeriodEnd: result.billingPeriodEnd ?? null,
      currency,
      totalBilledMinorUnits,
      shipmentCount: result.shipmentCount ?? null,
      awbSamples: result.awbSamples.map((value) => canonicalizeWhitespace(value) ?? ""),
      summary: canonicalizeWhitespace(result.summary)
    },
    warnings
  };
}

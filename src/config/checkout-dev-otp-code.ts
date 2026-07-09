export class CheckoutDevOtpCodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutDevOtpCodeConfigError";
  }
}

type CheckoutDevOtpCodeEnv = {
  NODE_ENV?: string | undefined;
  APP_ENV?: string | undefined;
  CHECKOUT_DEV_OTP_CODE?: string | undefined;
};

function appRuntime(source: CheckoutDevOtpCodeEnv) {
  const nodeEnv = String(source.NODE_ENV ?? "").trim().toLowerCase();
  return String(source.APP_ENV ?? (nodeEnv ? (nodeEnv === "production" ? "production" : nodeEnv) : "production")).trim().toLowerCase();
}

function hasCheckoutDevOtpCode(source: CheckoutDevOtpCodeEnv) {
  return Boolean(String(source.CHECKOUT_DEV_OTP_CODE ?? "").trim());
}

export function assertCheckoutDevOtpCodeProductionSafety(source: CheckoutDevOtpCodeEnv = process.env) {
  if (appRuntime(source) === "production" && hasCheckoutDevOtpCode(source)) {
    throw new CheckoutDevOtpCodeConfigError("CHECKOUT_DEV_OTP_CODE is forbidden in production");
  }
}

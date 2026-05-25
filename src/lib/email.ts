import nodemailer from "nodemailer";
import { HttpError } from "./httpError.js";
import { logger } from "./logger.js";

export type TransactionalEmailType =
  | "verify-email"
  | "account-created"
  | "seller-invite"
  | "courier-invite"
  | "password-reset"
  | "lead-submitted"
  | "wallet-created"
  | "shipment-created"
  | "shipment-status-update"
  | "ndr-update"
  | "domain-payment-received"
  | "domain-registration-started"
  | "domain-registered"
  | "domain-renewal-reminder"
  | "domain-ekyc-pending"
  | "domain-verification-required"
  | "domain-live";

export type JournalEmailLogPrefix = "journal_test_email_send" | "journal_email_send";

type SmtpError = Error & {
  code?: string;
  command?: string;
  responseCode?: number;
};

export type SendTransactionalEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  type: TransactionalEmailType;
  metadata?: Record<string, unknown>;
};

export type SendJournalEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  logPrefix: JournalEmailLogPrefix;
  metadata?: Record<string, unknown>;
};

const footerText = "This is an automated Shipmastr notification. Please do not reply to this email.";
const footerHtml = `<p style="margin-top:24px;color:#6b7280;font-size:12px;">${footerText}</p>`;

export type TransactionalEmailConfigStatus = {
  smtpHostConfigured: boolean;
  smtpPortConfigured: boolean;
  smtpUserConfigured: boolean;
  smtpPassConfigured: boolean;
  emailFromConfigured: boolean;
};

function readProcessEnvString(key: string) {
  const value = process.env[key];
  return typeof value === "string" ? value.trim() : "";
}

function readProcessEnvBoolean(key: string, fallback: boolean) {
  const value = readProcessEnvString(key).toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

export function getTransactionalEmailConfigStatus(source: NodeJS.ProcessEnv = process.env): TransactionalEmailConfigStatus {
  const read = (key: string) => {
    const value = source[key];
    return typeof value === "string" ? value.trim() : "";
  };

  return {
    smtpHostConfigured: Boolean(read("SMTP_HOST")),
    smtpPortConfigured: Boolean(read("SMTP_PORT")),
    smtpUserConfigured: Boolean(read("SMTP_USER")),
    smtpPassConfigured: Boolean(source.SMTP_PASS),
    emailFromConfigured: Boolean(read("EMAIL_FROM"))
  };
}

function smtpDiagnostics(err?: SmtpError) {
  const status = getTransactionalEmailConfigStatus();
  return {
    SMTP_HOST: status.smtpHostConfigured,
    SMTP_PORT: status.smtpPortConfigured,
    SMTP_USER: status.smtpUserConfigured,
    SMTP_FROM: Boolean(readProcessEnvString("SMTP_FROM")),
    EMAIL_FROM: status.emailFromConfigured,
    SMTP_REPLY_TO: Boolean(readProcessEnvString("SMTP_REPLY_TO")),
    SMTP_PASS: status.smtpPassConfigured,
    errorCode: err?.code,
    errorCommand: err?.command,
    errorResponseCode: err?.responseCode,
    errorMessage: err?.message
  };
}

function safeSmtpError(err: SmtpError) {
  return {
    errorCode: err.code,
    errorCommand: err.command,
    errorResponseCode: err.responseCode,
    errorMessage: err.message?.slice(0, 240)
  };
}

function normalizeAddressList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry && typeof entry === "object" && "address" in entry && typeof entry.address === "string") {
        return entry.address;
      }
      return "";
    })
    .filter(Boolean);
}

function normalizeSendResult(result: unknown) {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return {
    messageId: typeof record.messageId === "string" ? record.messageId : null,
    accepted: normalizeAddressList(record.accepted),
    rejected: normalizeAddressList(record.rejected),
    response: typeof record.response === "string" ? record.response : null
  };
}

function getSmtpConfig() {
  const host = readProcessEnvString("SMTP_HOST");
  const portValue = readProcessEnvString("SMTP_PORT");
  const port = Number.parseInt(portValue, 10);
  const user = readProcessEnvString("SMTP_USER");
  const pass = process.env.SMTP_PASS;
  const fromEmail = readProcessEnvString("EMAIL_FROM");
  const fromName = readProcessEnvString("EMAIL_FROM_NAME") || "Shipmastr";
  const from = fromEmail ? `${fromName} <${fromEmail}>` : undefined;
  const replyTo = readProcessEnvString("SMTP_REPLY_TO") || "no-reply@shipmastr.com";

  if (!host || !Number.isFinite(port) || !user || !pass || !from) {
    logger.warn({ smtp: smtpDiagnostics() }, "SMTP config missing");
    throw new HttpError(503, "SMTP_NOT_CONFIGURED");
  }

  return {
    host,
    port,
    secure: readProcessEnvBoolean("SMTP_SECURE", true),
    user,
    pass,
    from,
    replyTo
  };
}

export function isTransactionalEmailConfigured() {
  const status = getTransactionalEmailConfigStatus();
  return isTransactionalEmailConfiguredFromStatus(status);
}

export function isTransactionalEmailConfiguredFromStatus(status?: TransactionalEmailConfigStatus) {
  const configStatus = status ?? getTransactionalEmailConfigStatus();
  return Boolean(
    configStatus.smtpHostConfigured &&
    configStatus.smtpPortConfigured &&
    configStatus.smtpUserConfigured &&
    configStatus.smtpPassConfigured &&
    configStatus.emailFromConfigured
  );
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendTransactionalEmail(input: SendTransactionalEmailInput) {
  const smtp = getSmtpConfig();
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      user: smtp.user,
      pass: smtp.pass
    }
  });

  try {
    const result = await transporter.sendMail({
      from: smtp.from,
      replyTo: smtp.replyTo,
      to: input.to,
      subject: input.subject,
      text: `${input.text}\n\n${footerText}`,
      html: `${input.html}${footerHtml}`
    });

    logger.info(
      {
        email: {
          type: input.type,
          to: input.to,
          status: "sent",
          messageId: result.messageId,
          metadata: input.metadata
        }
      },
      "Transactional email sent"
    );

    return result;
  } catch (err) {
    const smtpError = err as SmtpError;
    logger.error(
      {
        email: {
          type: input.type,
          to: input.to,
          status: "failed",
          metadata: input.metadata
        },
        smtp: smtpDiagnostics(smtpError)
      },
      "Transactional email failed"
    );

    if (
      smtpError.code === "EAUTH" ||
      smtpError.command === "AUTH" ||
      smtpError.responseCode === 534 ||
      smtpError.responseCode === 535
    ) {
      throw new HttpError(502, "SMTP_AUTH_FAILED");
    }

    throw new HttpError(502, "SMTP_SEND_FAILED");
  }
}

export async function sendJournalEmail(input: SendJournalEmailInput) {
  const smtp = getSmtpConfig();
  const provider = "smtp";
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      user: smtp.user,
      pass: smtp.pass
    }
  });

  const startedEvent = `${input.logPrefix}_started`;
  const resultEvent = `${input.logPrefix}_result`;
  const failedEvent = `${input.logPrefix}_failed`;

  logger.info(
    {
      message: startedEvent,
      journalEmail: {
        provider,
        to: input.to,
        subject: input.subject,
        metadata: input.metadata
      }
    },
    startedEvent
  );

  try {
    const result = await transporter.sendMail({
      from: smtp.from,
      replyTo: smtp.replyTo,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html
    });
    const safeResult = normalizeSendResult(result);

    logger.info(
      {
        message: resultEvent,
        journalEmail: {
          provider,
          to: input.to,
          subject: input.subject,
          status: "sent",
          ...safeResult,
          metadata: input.metadata
        }
      },
      resultEvent
    );

    return safeResult;
  } catch (err) {
    const smtpError = err as SmtpError;
    logger.error(
      {
        message: failedEvent,
        journalEmail: {
          provider,
          to: input.to,
          subject: input.subject,
          status: "failed",
          metadata: input.metadata
        },
        smtp: safeSmtpError(smtpError)
      },
      failedEvent
    );

    if (
      smtpError.code === "EAUTH" ||
      smtpError.command === "AUTH" ||
      smtpError.responseCode === 534 ||
      smtpError.responseCode === 535
    ) {
      throw new HttpError(502, "SMTP_AUTH_FAILED", safeSmtpError(smtpError));
    }

    throw new HttpError(502, "SMTP_SEND_FAILED", safeSmtpError(smtpError));
  }
}

export const emailTemplates = {
  verifyEmail({ code }: { code: string }) {
    return {
      subject: "Your Shipmastr verification code",
      text: `Your Shipmastr verification code is ${code}. It expires in 10 minutes.`,
      html: `<p>Your Shipmastr verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`
    };
  },

  accountCreated({ businessName }: { businessName: string }) {
    return {
      subject: "Your Shipmastr seller account is ready",
      text: `Your Shipmastr seller account for ${businessName} has been created successfully.`,
      html: `<p>Your Shipmastr seller account for <strong>${businessName}</strong> has been created successfully.</p>`
    };
  },

  sellerInvite({ inviteLink, businessName }: { inviteLink: string; businessName: string }) {
    return {
      subject: "Your Shipmastr seller access is ready",
      text: [
        `Your Shipmastr seller account for ${businessName} is ready.`,
        "Set your password to start onboarding:",
        inviteLink
      ].join("\n"),
      html: `<p>Your Shipmastr seller account for <strong>${businessName}</strong> is ready.</p><p><a href="${inviteLink}">Set your password</a> to start onboarding.</p>`
    };
  },

  courierInvite({ inviteLink, courierName, contactName }: { inviteLink: string; courierName: string; contactName: string }) {
    return {
      subject: "Your Shipmastr courier integration portal is ready",
      text: [
        `Hi ${contactName},`,
        `Shipmastr has created the courier integration workspace for ${courierName}.`,
        "Set your password and submit the API, commercial, serviceability, COD, webhook, and escalation details here:",
        inviteLink,
        "Manual booking remains active until sandbox credentials are verified."
      ].join("\n"),
      html: `<p>Hi ${escapeHtml(contactName)},</p><p>Shipmastr has created the courier integration workspace for <strong>${escapeHtml(courierName)}</strong>.</p><p><a href="${inviteLink}">Set your password</a> and submit the required integration details.</p><p>Manual booking remains active until sandbox credentials are verified.</p>`
    };
  },

  passwordReset({ resetLink, businessName }: { resetLink: string; businessName: string }) {
    return {
      subject: "Reset your Shipmastr password",
      text: [
        `Password reset requested for ${businessName}.`,
        "Use this link to set a new password:",
        resetLink,
        "If you did not request this, you can ignore this email."
      ].join("\n"),
      html: `<p>Password reset requested for <strong>${businessName}</strong>.</p><p><a href="${resetLink}">Set a new password</a>.</p><p>If you did not request this, you can ignore this email.</p>`
    };
  },

  leadSubmitted(input: {
    businessName: string;
    name: string;
    email: string;
    phone: string;
    monthlyShipments?: string | null;
    biggestIssue?: string | null;
    notes?: string | null;
  }) {
    const rows = [
      ["Business", input.businessName],
      ["Name", input.name],
      ["Email", input.email],
      ["Phone", input.phone],
      ["Monthly shipments", input.monthlyShipments || "Not shared"],
      ["Biggest issue", input.biggestIssue || "Not shared"],
      ["Notes", input.notes || "Not shared"]
    ];

    return {
      subject: `New Shipmastr demo request: ${input.businessName}`,
      text: [
        "New Shipmastr request-demo lead received.",
        ...rows.map(([label, value]) => `${label}: ${value}`)
      ].join("\n"),
      html: [
        "<p>New Shipmastr request-demo lead received.</p>",
        "<table cellpadding=\"8\" cellspacing=\"0\" style=\"border-collapse:collapse;border:1px solid #e5e7eb;\">",
        ...rows.map(([label, value]) => (
          `<tr><td style="border:1px solid #e5e7eb;color:#6b7280;"><strong>${escapeHtml(label)}</strong></td><td style="border:1px solid #e5e7eb;">${escapeHtml(value)}</td></tr>`
        )),
        "</table>"
      ].join("")
    };
  },

  walletCreated({ businessName }: { businessName: string }) {
    return {
      subject: "Your Shipmastr wallet is ready",
      text: `Your Shipmastr wallet for ${businessName} is ready for seller operations.`,
      html: `<p>Your Shipmastr wallet for <strong>${businessName}</strong> is ready for seller operations.</p>`
    };
  },

  shipmentCreated(input: {
    orderId: string;
    awbNumber: string;
    carrier: string;
    trackingUrl: string;
    expectedDeliveryDate?: string | null;
  }) {
    const etaLine = input.expectedDeliveryDate ? `Expected delivery: ${input.expectedDeliveryDate}` : "";
    return {
      subject: `Shipment created for order ${input.orderId}`,
      text: [
        `Shipment created for order ${input.orderId}.`,
        `AWB: ${input.awbNumber}`,
        `Carrier: ${input.carrier}`,
        etaLine,
        `Track shipment: ${input.trackingUrl}`
      ].filter(Boolean).join("\n"),
      html: [
        `<p>Shipment created for order <strong>${input.orderId}</strong>.</p>`,
        `<p><strong>AWB:</strong> ${input.awbNumber}<br><strong>Carrier:</strong> ${input.carrier}</p>`,
        input.expectedDeliveryDate ? `<p><strong>Expected delivery:</strong> ${input.expectedDeliveryDate}</p>` : "",
        `<p><a href="${input.trackingUrl}">Track shipment</a></p>`
      ].join("")
    };
  },

  shipmentStatusUpdate(input: {
    orderId: string;
    awbNumber: string;
    currentStatus: string;
    latestEvent: string;
    trackingUrl: string;
  }) {
    return {
      subject: `Shipment status update: ${input.currentStatus}`,
      text: [
        `Order ID: ${input.orderId}`,
        `AWB: ${input.awbNumber}`,
        `Current status: ${input.currentStatus}`,
        `Latest event: ${input.latestEvent}`,
        `Track shipment: ${input.trackingUrl}`
      ].join("\n"),
      html: `<p><strong>Order ID:</strong> ${input.orderId}<br><strong>AWB:</strong> ${input.awbNumber}<br><strong>Current status:</strong> ${input.currentStatus}</p><p>${input.latestEvent}</p><p><a href="${input.trackingUrl}">Track shipment</a></p>`
    };
  },

  ndrUpdate(input: {
    orderId: string;
    awbNumber: string;
    latestEvent: string;
    trackingUrl: string;
  }) {
    return {
      subject: `NDR update for order ${input.orderId}`,
      text: [
        `NDR update for order ${input.orderId}.`,
        `AWB: ${input.awbNumber}`,
        `Latest event: ${input.latestEvent}`,
        `Track shipment: ${input.trackingUrl}`
      ].join("\n"),
      html: `<p>NDR update for order <strong>${input.orderId}</strong>.</p><p><strong>AWB:</strong> ${input.awbNumber}</p><p>${input.latestEvent}</p><p><a href="${input.trackingUrl}">Track shipment</a></p>`
    };
  }
};

export function trackingUrl(awbNumber: string) {
  return `https://shipmastr.com/tracking/?awb=${encodeURIComponent(awbNumber)}`;
}

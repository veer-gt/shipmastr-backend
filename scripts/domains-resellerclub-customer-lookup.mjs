import dotenv from "dotenv";

dotenv.config({ quiet: true });

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`${name}_MISSING`);
  }
  return String(value).trim();
}

function baseUrl() {
  return requiredEnv("RESELLERCLUB_BASE_URL").replace(/\/+$/, "");
}

function authParams() {
  return {
    "auth-userid": requiredEnv("RESELLERCLUB_AUTH_USERID"),
    "api-key": requiredEnv("RESELLERCLUB_API_KEY")
  };
}

function operationalId(value, confirmed) {
  if (!value) return null;
  return confirmed ? String(value) : "[hidden: pass --confirm-print-operational-ids to print]";
}

async function main() {
  if (process.env.ALLOW_RESELLERCLUB_READ_ONLY_DISCOVERY !== "true") {
    throw new Error("ALLOW_RESELLERCLUB_READ_ONLY_DISCOVERY must be true for read-only provider discovery");
  }

  const username = argValue("--username");
  if (!username) {
    throw new Error("Usage: npm run domains:resellerclub-customer-lookup -- --username customer@example.com --confirm-print-operational-ids");
  }

  const confirmed = hasArg("--confirm-print-operational-ids");
  const params = new URLSearchParams({
    ...authParams(),
    username
  });
  const url = `${baseUrl()}/api/customers/details.json?${params.toString()}`;
  const response = await fetch(url, { method: "GET" });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }

  console.log(JSON.stringify({
    operation: "read-only customer lookup",
    endpointPath: "/api/customers/details.json",
    httpStatus: response.status,
    customerId: operationalId(body.customerid, confirmed),
    resellerIdPresent: Boolean(body.resellerid),
    salesContactId: operationalId(body.salescontactid, confirmed),
    customerStatus: typeof body.customerstatus === "string" ? body.customerstatus : undefined,
    printedPersonalData: false,
    printedSecrets: false,
    note: "Read-only lookup only: no registration attempted"
  }, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    error: "RESELLERCLUB_CUSTOMER_LOOKUP_BLOCKED",
    message,
    note: "Read-only lookup only: no registration attempted"
  }, null, 2));
  process.exitCode = 1;
});

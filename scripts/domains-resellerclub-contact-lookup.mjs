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

function contactEntries(body) {
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body)) return body;
  return Object.values(body).filter((entry) => entry && typeof entry === "object");
}

function summarizeContact(entry, confirmed) {
  const record = entry || {};
  const entity = record.entity && typeof record.entity === "object" ? record.entity : record;
  const contact = record.contact && typeof record.contact === "object" ? record.contact : record;
  return {
    contactId: operationalId(entity.entityid || record.entityid || record.contactid, confirmed),
    customerId: operationalId(entity.customerid || record.customerid, confirmed),
    type: typeof contact.type === "string" ? contact.type : undefined,
    currentStatus: typeof entity.currentstatus === "string" ? entity.currentstatus : undefined,
    registryStatus: typeof record.contactstatus === "string" ? record.contactstatus : undefined
  };
}

async function main() {
  if (process.env.ALLOW_RESELLERCLUB_READ_ONLY_DISCOVERY !== "true") {
    throw new Error("ALLOW_RESELLERCLUB_READ_ONLY_DISCOVERY must be true for read-only provider discovery");
  }

  const customerId = argValue("--customer-id");
  const contactId = argValue("--contact-id");
  if (!customerId && !contactId) {
    throw new Error("Usage: npm run domains:resellerclub-contact-lookup -- --customer-id 123 --confirm-print-operational-ids");
  }

  const confirmed = hasArg("--confirm-print-operational-ids");
  const endpointPath = contactId ? "/api/contacts/details.json" : "/api/contacts/search.json";
  const params = new URLSearchParams({
    ...authParams(),
    ...(contactId
      ? { "contact-id": contactId }
      : {
          "customer-id": String(customerId),
          "no-of-records": "10",
          "page-no": "1"
        })
  });
  const response = await fetch(`${baseUrl()}${endpointPath}?${params.toString()}`, { method: "GET" });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  const contacts = contactId ? [summarizeContact(body, confirmed)] : contactEntries(body).map((entry) => summarizeContact(entry, confirmed));

  console.log(JSON.stringify({
    operation: "read-only contact lookup",
    endpointPath,
    httpStatus: response.status,
    recordsReturned: contacts.length,
    contacts,
    printedPersonalData: false,
    printedSecrets: false,
    note: "Read-only lookup only: no registration attempted"
  }, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    error: "RESELLERCLUB_CONTACT_LOOKUP_BLOCKED",
    message,
    note: "Read-only lookup only: no registration attempted"
  }, null, 2));
  process.exitCode = 1;
});

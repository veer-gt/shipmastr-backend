#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

export const DEV_PINCODE_FIXTURE = [
  {
    pincode: "110001",
    city: "New Delhi",
    district: "New Delhi",
    state: "Delhi",
    locality: "Connaught Place",
    lat: "28.6315000",
    lng: "77.2167000"
  },
  {
    pincode: "560001",
    city: "Bengaluru",
    district: "Bengaluru Urban",
    state: "Karnataka",
    locality: "MG Road",
    lat: "12.9756000",
    lng: "77.6068000"
  },
  {
    pincode: "400001",
    city: "Mumbai",
    district: "Mumbai",
    state: "Maharashtra",
    locality: "Fort",
    lat: "18.9388000",
    lng: "72.8354000"
  }
];

function clean(value) {
  return String(value ?? "").trim();
}

function cleanPincode(value) {
  const pin = clean(value).replace(/\D/g, "");
  return /^\d{6}$/.test(pin) ? pin : "";
}

function cleanDecimal(value) {
  const text = clean(value);
  if (!text) return null;
  return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
}

function uniquePush(values, value) {
  const cleaned = clean(value);
  if (cleaned && !values.includes(cleaned)) values.push(cleaned);
}

function parseCsvRecords(text) {
  const records = [];
  let field = "";
  let record = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        field += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      record.push(field);
      field = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      record.push(field);
      if (record.some((value) => clean(value))) records.push(record);
      record = [];
      field = "";
      continue;
    }

    field += char;
  }

  record.push(field);
  if (record.some((value) => clean(value))) records.push(record);
  return records;
}

function rowValue(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && clean(row[name])) return row[name];
  }
  return "";
}

function normalizeHeader(value) {
  return clean(value).toLowerCase().replace(/[\s_-]+/g, "");
}

function rowsFromCsv(text) {
  const records = parseCsvRecords(text);
  if (records.length === 0) return [];

  const headers = records[0].map(normalizeHeader);
  return records.slice(1).map((record) => {
    const row = {};
    headers.forEach((header, index) => {
      row[header] = record[index] ?? "";
    });
    return row;
  });
}

function rowsFromJson(text) {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.data)) return parsed.data;
  if (Array.isArray(parsed?.rows)) return parsed.rows;
  throw new Error("Pincode JSON must be an array or contain data/rows array");
}

export function parsePincodeSeedContent(text, fileName = "pincodes.csv") {
  const ext = extname(fileName).toLowerCase();
  return ext === ".json" ? rowsFromJson(text) : rowsFromCsv(text);
}

export function normalizePincodeSeedRows(rows) {
  const aggregated = new Map();

  for (const row of rows) {
    const normalized = Object.fromEntries(
      Object.entries(row || {}).map(([key, value]) => [normalizeHeader(key), value])
    );
    const pincode = cleanPincode(rowValue(normalized, ["pincode", "pin", "postalcode", "zipcode"]));
    const state = clean(rowValue(normalized, ["state", "statename"]));
    const district = clean(rowValue(normalized, ["district", "districtname"]));
    const city = clean(rowValue(normalized, ["city", "cityname", "divisionname", "regionname"])) || district;
    const locality = rowValue(normalized, ["locality", "localities", "officename", "postoffice", "name"]);

    if (!pincode || !city || !district || !state) continue;

    const existing = aggregated.get(pincode) || {
      pincode,
      city,
      district,
      state,
      localities: [],
      lat: cleanDecimal(rowValue(normalized, ["lat", "latitude"])),
      lng: cleanDecimal(rowValue(normalized, ["lng", "lon", "longitude"]))
    };

    uniquePush(existing.localities, locality);
    if (!existing.lat) existing.lat = cleanDecimal(rowValue(normalized, ["lat", "latitude"]));
    if (!existing.lng) existing.lng = cleanDecimal(rowValue(normalized, ["lng", "lon", "longitude"]));
    aggregated.set(pincode, existing);
  }

  return Array.from(aggregated.values()).sort((a, b) => a.pincode.localeCompare(b.pincode));
}

export async function upsertAddressPincodes(client, records) {
  const upserted = [];

  for (const record of records) {
    const data = {
      city: record.city,
      district: record.district,
      state: record.state,
      localities: record.localities,
      lat: record.lat,
      lng: record.lng
    };
    const row = await client.addressPincode.upsert({
      where: { pincode: record.pincode },
      create: {
        pincode: record.pincode,
        ...data
      },
      update: data
    });
    upserted.push(row);
  }

  return upserted;
}

function filePathFromArgs(argv) {
  const fileIndex = argv.findIndex((arg) => arg === "--file" || arg === "--csv" || arg === "--json");
  if (fileIndex >= 0) return argv[fileIndex + 1] || "";
  return argv.find((arg) => !arg.startsWith("--")) || "";
}

async function main() {
  const filePath = filePathFromArgs(process.argv.slice(2));
  const usingDevFixture = !filePath;
  const rows = usingDevFixture
    ? DEV_PINCODE_FIXTURE
    : parsePincodeSeedContent(readFileSync(resolve(filePath), "utf8"), filePath);
  const records = normalizePincodeSeedRows(rows);

  const prisma = new PrismaClient();
  try {
    const upserted = await upsertAddressPincodes(prisma, records);
    console.log(JSON.stringify({
      ok: true,
      source: usingDevFixture ? "local-dev-fixture" : resolve(filePath),
      count: upserted.length,
      pincodes: upserted.map((row) => row.pincode)
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

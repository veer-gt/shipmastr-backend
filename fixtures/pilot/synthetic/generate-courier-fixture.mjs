#!/usr/bin/env node
// generate-courier-fixture.mjs — synthetic hostile courier MIS + paired seller export.
//
// PURPOSE: exercise the W0 pipeline (format pack authoring, dry-run loop, resolver,
// tie-out gate, e2e, recovery report) before a real courier file exists.
//
// ASSUMPTION LABEL: headers are Bigship-LIKE (aggregator MIS shape), not Bigship's
// actual export — swap the MIS_HEADERS array and row writer when a real file lands.
// Everything else (traps, join keys, manifest) stands.
//
// WHAT SYNTHETIC DATA PROVES: the machinery works end to end.
// WHAT IT CANNOT PROVE: that real hostility is handled — you cannot discover
// hostility you invented. Definition of done still requires a real file.
//
// Usage:
//   node generate-courier-fixture.mjs [--rows 60] [--seed 20260704]
//     [--period 2026-07] [--brand demo-brand] [--out ./fixture-kit-out] [--no-tie]
//
// Outputs (deterministic for a given seed):
//   <out>/bigship-mis-<period>.csv        hostile courier MIS
//   <out>/shopify-orders-<period>.csv     paired seller export (join spine)
//   <out>/traps-manifest.json             answer key: traps, totals, expectations
//
// Money: integer paise arithmetic only. No floats touch amounts.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------- args ----------
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const ROWS = parseInt(arg('rows', '60'), 10);
const SEED = parseInt(arg('seed', '20260704'), 10);
const PERIOD = String(arg('period', '2026-07'));           // YYYY-MM
const BRAND = String(arg('brand', 'demo-brand'));
const OUT = String(arg('out', './fixture-kit-out'));
const NO_TIE = arg('no-tie', false) === true;

const [YEAR, MONTH] = PERIOD.split('-').map((s) => parseInt(s, 10));
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][MONTH - 1];

// ---------- deterministic PRNG (mulberry32) ----------
let state = SEED >>> 0;
const rnd = () => {
  state |= 0; state = (state + 0x6D2B79F5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));   // inclusive ints
const pick = (xs) => xs[rint(0, xs.length - 1)];
const chance = (p) => rnd() < p;

// ---------- fake-but-realistic vocab (I17 exercise: these columns must never
// leave staging raw; all values are fabricated) ----------
const NAMES = ['Ravi Test','Priya Sample','Amit Placeholder','Neha Dummy','Karan Fixture','Divya Mock','Rohit Synthetic','Anita Faux'];
const FAKE_PHONE = () => `90000${String(rint(10000, 99999))}`;   // clearly fake 9xxxx block
const PINS = ['110001','122001','201301','226001','208001','400001','560001','700001','380001','302001'];
const COURIERS = ['Xpressbees','Delhivery','Ecom Express','DTDC'];
const ZONES = { A: 3500, B: 4500, C: 5500, D: 6500, E: 8000 };  // base paise
const ZONE_KEYS = Object.keys(ZONES);

// ---------- money helpers (paise ints only) ----------
const inr = (paise) => {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const r = Math.floor(abs / 100);
  const p = String(abs % 100).padStart(2, '0');
  // Indian grouping for the hostile variant: 1,23,456.78
  const s = String(r);
  const head = s.length > 3 ? s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3) : s;
  return `${sign}${head}.${p}`;
};
const csvEsc = (v) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const row = (cells) => cells.map(csvEsc).join(',');

// ---------- dates: two formats in the SAME column (trap T1) ----------
const dmy = (d) => `${String(d).padStart(2, '0')}/${String(MONTH).padStart(2, '0')}/${YEAR}`;
const dMonY = (d) => `${String(d).padStart(2, '0')}-${MONTH_ABBR}-${String(YEAR).slice(2)}`;
const fmtDate = (d, alt) => (alt ? dMonY(d) : dmy(d));

// ---------- build shipments ----------
const MIS_HEADERS = ['AWB No','Order Ref','Courier Partner','Booking Date','Delivery Status','Delivery Date','Origin Pin','Dest Pin','Zone','Payment Mode','Consignee Name','Consignee Contact','Declared Wt (Kg)','Charged Wt (Kg)','Charge Head','Freight Amt','COD Amt Collected','COD Charge','Net Amount','Remarks'];

const ships = [];
for (let i = 0; i < ROWS; i++) {
  const orderNo = 1001 + i;
  const awb = `BSHP00${7100000 + i * 13 + rint(0, 9)}`;
  const zone = pick(ZONE_KEYS);
  const declaredG = pick([250, 500, 500, 750, 1000, 1500]);      // grams
  const bump = chance(0.15);                                      // T13: weight bumps
  const chargedG = bump ? declaredG + pick([250, 500, 750]) : declaredG;
  const halfKgs = Math.max(1, Math.ceil(chargedG / 500));
  const freight = ZONES[zone] + Math.floor(ZONES[zone] * 0.4) * (halfKgs - 1);
  const cod = chance(0.65);
  const orderValue = rint(399, 2499) * 100;
  const codCharge = cod ? 4000 : 0;
  const booked = rint(1, 25);
  const delivered = booked + rint(2, 5);
  const rto = chance(0.07);                                       // T14 pool
  ships.push({ i, orderNo, awb, zone, declaredG, chargedG, bump, freight, cod, orderValue, codCharge, booked, delivered, rto, altDate: chance(0.4), courier: pick(COURIERS), name: pick(NAMES), phone: FAKE_PHONE(), opin: pick(PINS), dpin: pick(PINS) });
}

// ---------- trap selections (deterministic given seed) ----------
const traps = [];
const dupIdx = rint(5, Math.min(20, ROWS - 2));                   // T2 duplicate row
const rebill = ships[rint(21, Math.min(35, ROWS - 1))];           // T3 freight rebill
const mangled = [ships[rint(2, 10)], ships[rint(36, Math.min(45, ROWS - 1))]]; // T11
const wdAwbs = ships.filter((s) => s.bump).slice(0, 4);           // T13 debits
const wdCredit = wdAwbs[0];                                       // T13 credit (recovery)
const rtoShips = ships.filter((s) => s.rto).slice(0, 2);          // T14

// ---------- emit MIS lines ----------
const lines = [];
let computedTotal = 0;                                            // paise, data rows only
let misDataRows = 0;                                                // emitted data rows, including duplicate traps
let misDuplicateRows = 0;                                           // intentionally duplicated data rows
const push = (cells, net) => { lines.push(row(cells)); computedTotal += net; misDataRows += 1; };
const duplicatePreviousDataRow = (net) => { lines.push(lines[lines.length - 1]); computedTotal += net; misDataRows += 1; misDuplicateRows += 1; };

lines.push(row(MIS_HEADERS));
ships.forEach((s, idx) => {
  const status = rtoShips.includes(s) ? 'RTO Delivered' : 'Delivered';
  const orderRef = mangled.includes(s) ? (mangled[0] === s ? '' : `#${s.orderNo}A`) : `#${s.orderNo}`; // T11
  const net = s.freight + s.codCharge;
  const freightStr = s.freight >= 100000 || chance(0.2) ? inr(s.freight) : inr(s.freight); // commas appear via inr when big
  const netStr = idx === 7 ? `${inr(net)} ` : inr(net);           // T5: trailing space on one amount
  push([s.awb, orderRef, s.courier, fmtDate(s.booked, s.altDate), status, fmtDate(s.delivered, !s.altDate && chance(0.3)), s.opin, s.dpin, s.zone, s.cod ? 'COD' : 'PREPAID', s.name, s.phone, (s.declaredG / 1000).toFixed(3), (s.chargedG / 1000).toFixed(3), 'FREIGHT', freightStr, s.cod ? inr(s.orderValue) : '0.00', inr(s.codCharge), netStr, idx === 12 ? 'Zone reclass — refer annexure' : ''], net);

  if (idx === dupIdx) { const originalCsvRow = lines.length; duplicatePreviousDataRow(net); traps.push({ id: 'T2_duplicate_row', awb: s.awb, csvRows: [originalCsvRow, lines.length], expect: 'resolver: idempotent skip of one copy (identical line, overlapping drop)' }); }

  if (idx === 29 && ROWS > 30) { lines.push(''); lines.push(row(MIS_HEADERS)); traps.push({ id: 'T6_midfile_blank_and_header', csvRowApprox: lines.length, expect: 'parser: skip blank + repeated header (concatenated export), not data rows' }); }
});

// adjustment section (mixed row semantics — realistic hostility)
for (const s of wdAwbs) {
  const diff = Math.floor(ZONES[s.zone] * 0.4) * Math.max(1, Math.ceil((s.chargedG - s.declaredG) / 500));
  push([s.awb, `#${s.orderNo}`, s.courier, fmtDate(Math.min(28, s.delivered + 1), chance(0.5)), '', '', '', '', s.zone, '', '', '', (s.declaredG / 1000).toFixed(3), (s.chargedG / 1000).toFixed(3), 'WT DISC DEBIT', '', '', '', inr(diff), 'Weight re-audit'], diff);
  traps.push({ id: 'T13_weight_dispute_debit', awb: s.awb, amountPaise: diff, expect: 'maps to weight_dispute_hold (pending until W0C-4 aging)' });
}
{
  const s = wdCredit; const credit = -Math.floor(ZONES[s.zone] * 0.4);
  push([s.awb, `#${s.orderNo}`, s.courier, fmtDate(28, true), '', '', '', '', s.zone, '', '', '', '', '', 'WT DISC CREDIT', '', '', '', inr(credit), 'Dispute accepted'], credit);
  traps.push({ id: 'T13_weight_dispute_credit', awb: s.awb, amountPaise: credit, expect: 'maps to weight_dispute_release (recovery)' });
}
for (const s of rtoShips) {
  const rf = Math.floor(s.freight * 0.8);
  push([s.awb, `#${s.orderNo}`, s.courier, fmtDate(Math.min(28, s.delivered + 2), false), 'RTO Delivered', '', '', '', s.zone, '', '', '', '', '', 'RTO FREIGHT', '', '', '', inr(rf), 'Return leg'], rf);
  traps.push({ id: 'T14_rto_freight', awb: s.awb, amountPaise: rf, expect: 'maps to rto_freight_charge' });
}
{ // T3 freight rebill: same AWB, corrected (higher) freight in later row
  const s = rebill; const corrected = s.freight + Math.floor(ZONES[s.zone] * 0.4);
  push([s.awb, `#${s.orderNo}`, s.courier, fmtDate(Math.min(28, s.delivered + 3), true), 'Delivered', '', s.opin, s.dpin, s.zone, s.cod ? 'COD' : 'PREPAID', '', '', (s.declaredG / 1000).toFixed(3), ((s.chargedG + 500) / 1000).toFixed(3), 'FREIGHT REBILL', inr(corrected), '', '', inr(corrected), 'Rate correction'], corrected);
  traps.push({ id: 'T3_same_awb_rebill', awb: s.awb, originalPaise: s.freight + s.codCharge, correctedPaise: corrected, expect: 'resolver: reverse_and_repost candidate, not a duplicate exception' });
}
{ // T4 unknown charge head
  const s = ships[rint(46, ROWS - 1)]; const amt = 2350;
  push([s.awb, `#${s.orderNo}`, s.courier, fmtDate(27, false), '', '', '', '', s.zone, '', '', '', '', '', 'MISC ADJ', '', '', '', inr(amt), 'Ref CN-2231'], amt);
  traps.push({ id: 'T4_unknown_charge_head', awb: s.awb, head: 'MISC ADJ', amountPaise: amt, expect: 'exception that grows the charge-code dictionary once' });
}

// footer total row (T7) — must be excluded from data parsing
const statedTotal = computedTotal + (NO_TIE ? 15000 : 0);
lines.push(row(['', '', '', '', '', '', '', '', '', '', '', '', '', '', 'TOTAL', '', '', '', inr(statedTotal), '']));
traps.push({ id: 'T7_footer_total_row', expect: 'parser: footer excluded from data rows; its amount is statedTotalMinor input' });
traps.push({ id: 'T1_mixed_date_formats', expect: 'DD/MM/YYYY and DD-Mon-YY interleaved in same columns; pack date rules must handle both' });
traps.push({ id: 'T5_amount_hostility', expect: 'Indian comma grouping (quoted) and one trailing-space amount (csv row 9); paise parsing must survive both' });
traps.push({ id: 'T9_three_decimal_weights', expect: 'weights carry 3 decimals; grams conversion must not float-drift' });
traps.push({ id: 'T10_consignee_pii_columns', expect: 'fake names/phones present; must exist ONLY in staging raw (I17), never in journal/report output' });
traps.push({ id: 'T11_unresolvable_order_refs', awbs: mangled.map((s) => s.awb), expect: 'resolver: unresolved-shipment exceptions (blank ref, mangled ref)' });

// ---------- seller export (join spine; Shopify-ish) ----------
const ORD_HEADERS = ['Name','Created at','Financial Status','Fulfillment Status','Total','Shipping Method','Email','Phone','Shipping Zip'];
const ordLines = [row(ORD_HEADERS)];
for (const s of ships) {
  ordLines.push(row([`#${s.orderNo}`, `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(s.booked).padStart(2, '0')} 11:${String(rint(10, 59))}:00 +0530`, s.cod ? 'pending' : 'paid', 'fulfilled', inr(s.orderValue), s.cod ? 'COD' : 'Standard', `buyer${s.orderNo}@example.invalid`, FAKE_PHONE(), s.dpin]));
}
for (let k = 0; k < 2; k++) { // T12: orders with no MIS row (unbilled — finding, not exception)
  const n = 1001 + ROWS + k;
  ordLines.push(row([`#${n}`, `${YEAR}-${String(MONTH).padStart(2, '0')}-26 15:0${k}:00 +0530`, 'paid', 'fulfilled', inr(rint(399, 1499) * 100), 'Standard', `buyer${n}@example.invalid`, FAKE_PHONE(), pick(PINS)]));
  traps.push({ id: 'T12_unbilled_order', orderRef: `#${n}`, expect: 'audit finding (shipment never billed), not a pipeline exception' });
}

// ---------- write ----------
mkdirSync(OUT, { recursive: true });
const misPath = join(OUT, `bigship-mis-${PERIOD}.csv`);
const ordPath = join(OUT, `shopify-orders-${PERIOD}.csv`);
const manPath = join(OUT, 'traps-manifest.json');
writeFileSync(misPath, lines.join('\n') + '\n');
writeFileSync(ordPath, ordLines.join('\n') + '\n');
writeFileSync(manPath, JSON.stringify({
  generator: 'generate-courier-fixture.mjs', seed: SEED, period: PERIOD, brand: BRAND,
  assumption: 'Bigship-LIKE aggregator MIS shape; swap MIS_HEADERS + row writer when a real file lands',
  joinKey: 'MIS "Order Ref" ↔ orders "Name" (#100x)',
  files: { mis: misPath, orders: ordPath },
  shipmentRows: ROWS,
  misDataRows,
  misDuplicateRows,
  misUniqueEconomicRows: misDataRows - misDuplicateRows,
  computedTotalMinor: computedTotal, statedTotalMinor: statedTotal, ties: !NO_TIE,
  awbNote: 'AWBs use fake BSHP00xxxxxxx namespace; re-key consistently when anonymizing real files',
  traps
}, null, 2) + '\n');

console.log(`MIS:      ${misPath}`);
console.log(`Orders:   ${ordPath}`);
console.log(`Manifest: ${manPath}`);
console.log(`Computed total: ${inr(computedTotal)}  Stated total: ${inr(statedTotal)}  ties=${!NO_TIE}`);

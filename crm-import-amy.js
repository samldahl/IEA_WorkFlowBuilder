// ── Source list import ───────────────────────────────────────────────────────
// Loads the lists Amy maintains outside the CRM into it, keeping each one
// identifiable as the separate list it is kept as (see crm-lists.js).
//
//   python tools/xlsx-to-csv.py      # refresh the CSVs from the workbooks
//   node crm-import-amy.js --dry-run # see what would change
//   node crm-import-amy.js           # apply
//   node crm-import-amy.js --undo    # remove the list tags, delete what it created
//
// Re-running is safe. Records are matched on client number, then email, then
// company plus surname, so a refreshed sheet updates rather than duplicates.
//
// Merging is deliberately timid: an existing contact only ever gains values for
// fields it does not already have. A spreadsheet is a snapshot of what someone
// knew when they typed it, and it should not be allowed to overwrite a phone
// number or a title that somebody has since corrected in the app.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// Requiring the CRM module registers the Mongoose models, so the schemas live
// in exactly one place.
require('./crm');
const lists = require('./crm-lists');
const trackerSheet = require('./crm-tracker');

const Contact = mongoose.model('Contact');

const CONVERTED_DIR = path.join(__dirname, 'FromAmy', 'converted');
const SOURCE_DIR = path.join(__dirname, 'FromAmy');

// Marks every record this script creates, so --undo knows what it may remove
// and a human can tell an imported row from a hand-entered one.
const IMPORT_SOURCE = 'amy-list-import';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const UNDO = args.includes('--undo');
const ONLY = (args.find(a => a.startsWith('--list=')) || '').split('=')[1] || null;

// ── CSV ──────────────────────────────────────────────────────────────────────
// The converter writes well-formed CSV, but these cells carry commas, quotes
// and newlines, so this is a real parser rather than a split on commas.

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

function csvToObjects(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => String(h).trim());
  return rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { if (h) o[h] = r[i] == null ? '' : r[i]; });
    return o;
  });
}

// The converter's filename scheme: <workbook stem>__<sheet name>.csv, both slugged.
function slug(s) {
  return String(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function csvPathFor(list) {
  const stem = slug(path.basename(list.file, path.extname(list.file)));
  return path.join(CONVERTED_DIR, `${stem}__${slug(list.sheet)}.csv`);
}

// ── Matching ─────────────────────────────────────────────────────────────────

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Company names in these sheets vary by suffix — "Acrotech, Inc." and
// "AcroTech" are the same firm — so suffixes come off before comparing.
function companyKey(s) {
  return norm(s).replace(/\b(inc|llc|llp|ltd|corp|corporation|company|co|group|the)\b/g, '').replace(/\s+/g, ' ').trim();
}

function keysFor(rec) {
  const out = [];
  if (rec.externalId) out.push('x:' + norm(rec.externalId));
  if (rec.email) out.push('e:' + rec.email.toLowerCase());
  const ck = companyKey(rec.company);
  if (ck && rec.lastName) out.push('cn:' + ck + '|' + norm(rec.lastName));
  // A company-only key is right for the prospect sheets, where the row is the
  // firm and nobody has been named yet. It would be wrong for a contact sheet,
  // where several people share an employer — hence the guard.
  if (ck && !rec.lastName && !rec.firstName) out.push('c:' + ck);
  return out;
}

function indexExisting(docs) {
  const map = new Map();
  docs.forEach(d => {
    const keys = [];
    if (d.externalId) keys.push('x:' + norm(d.externalId));
    if (d.email) keys.push('e:' + String(d.email).toLowerCase());
    const ck = companyKey(d.company);
    if (ck && d.lastName) keys.push('cn:' + ck + '|' + norm(d.lastName));
    if (ck && !d.lastName && !d.firstName) keys.push('c:' + ck);
    keys.forEach(k => { if (!map.has(k)) map.set(k, d); });
  });
  return map;
}

// ── Merge ────────────────────────────────────────────────────────────────────

const SCALAR_FIELDS = [
  'firstName', 'lastName', 'title', 'company', 'email', 'phone', 'office',
  'segment', 'leadSource', 'clientTier', 'eventName', 'lastTouchType',
  'lastTouchNote', 'nextAction', 'externalId',
];
const DATE_FIELDS = ['lastTouchAt', 'capturedAt', 'firstContactAt', 'lastProjectAt'];

function isEmpty(v) {
  return v === undefined || v === null || v === '' ||
    (Array.isArray(v) && v.length === 0);
}

// Returns the fields that would actually change, or null for a no-op.
function diffFor(existing, incoming, listId) {
  const set = {};

  SCALAR_FIELDS.forEach(f => {
    if (!isEmpty(incoming[f]) && isEmpty(existing[f])) set[f] = incoming[f];
  });
  DATE_FIELDS.forEach(f => {
    if (!incoming[f]) return;
    const have = existing[f] ? new Date(existing[f]).getTime() : 0;
    const want = new Date(incoming[f]).getTime();
    // A newer last-touch date is worth taking; an older one is not, or the
    // sheet's year-only guess would make a freshly contacted client look cold.
    if (f === 'lastTouchAt' ? want > have : !existing[f]) set[f] = incoming[f];
  });

  if (incoming.lastTouchEstimated && isEmpty(existing.lastTouchAt)) set.lastTouchEstimated = true;
  if (incoming.newTarget && !existing.newTarget) set.newTarget = true;

  // Notes append rather than replace — the sheet's commentary is additional
  // context, not a correction of whatever is already recorded.
  if (incoming.notes && !String(existing.notes || '').includes(incoming.notes.split('\n')[0])) {
    set.notes = [existing.notes, incoming.notes].filter(Boolean).join('\n\n');
  }

  const addTags = (incoming.tags || []).filter(t => !(existing.tags || []).includes(t));
  const addList = (existing.lists || []).includes(listId) ? [] : [listId];

  if (!Object.keys(set).length && !addTags.length && !addList.length) return null;
  return { set, addTags, addList };
}

function newDoc(incoming, listId, now) {
  return {
    ...incoming,
    lists: [listId],
    tags: incoming.tags || [],
    source: IMPORT_SOURCE,
    // The sheet is where this lead was being kept, so that is when it was
    // logged. Using the import time instead would invent an SOP breach that
    // never happened.
    loggedAt: incoming.capturedAt || now,
    createdAt: now,
    updatedAt: now,
  };
}

// ── Loaders ──────────────────────────────────────────────────────────────────

function classifySegment(v) {
  return trackerSheet.classify(v, trackerSheet.SEGMENTS, '');
}

function loadList(list, now) {
  if (list.mapper === 'eventMarkdown') {
    const file = path.join(SOURCE_DIR, list.file);
    if (!fs.existsSync(file)) return { missing: file, records: [] };
    const entries = lists.parseEventMarkdown(fs.readFileSync(file, 'utf8'), now.getFullYear());
    // An action written in the past tense means somebody already reached out,
    // even where the box is still unticked — "sent email follow up with info"
    // is a record, not an instruction. Treating those as untouched would fill
    // the overdue queue with false alarms.
    //
    // The test runs over the action lines only. The notes blob always opens
    // with "Met at: <event>", so testing that would match every single entry.
    const DID = /\b(sent|emailed|e-?mailed|called|forwarded|left (a )?v(oice)?mail|already connected|reached out)\b/i;
    const records = entries.map(e => {
      const rec = lists.mapEventEntry(e, list);
      if (!rec) return null;
      const reachedOut = e.actions.some(a => a.done || DID.test(a.text));
      return reachedOut && rec.capturedAt ? { ...rec, firstContactAt: rec.capturedAt } : rec;
    }).filter(Boolean);
    return { records };
  }

  const file = csvPathFor(list);
  if (!fs.existsSync(file)) return { missing: file, records: [] };
  const rows = csvToObjects(fs.readFileSync(file, 'utf8'));
  const map = list.mapper === 'prospect'
    ? r => lists.mapProspectRow(r, list)
    : r => lists.mapClientRow(r, list, classifySegment, now.getTime());
  return { records: rows.map(map).filter(Boolean) };
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function undo() {
  const defs = lists.LISTS.filter(l => !ONLY || l.id === ONLY);
  for (const list of defs) {
    const created = await Contact.countDocuments({ lists: list.id, source: IMPORT_SOURCE });
    const tagged = await Contact.countDocuments({ lists: list.id });
    if (DRY) {
      console.log(`${list.id}: would delete ${created} imported, untag ${tagged - created} pre-existing`);
      continue;
    }
    // Only delete what this script created. A contact that already existed and
    // merely picked up a list tag keeps everything except the tag.
    const del = await Contact.deleteMany({ lists: list.id, source: IMPORT_SOURCE });
    const upd = await Contact.updateMany({ lists: list.id }, { $pull: { lists: list.id } });
    console.log(`${list.id}: deleted ${del.deletedCount}, untagged ${upd.modifiedCount}`);
  }
}

async function run() {
  const now = new Date();
  const defs = lists.LISTS.filter(l => !ONLY || l.id === ONLY);
  const summary = [];

  for (const list of defs) {
    const { records, missing } = loadList(list, now);
    if (missing) {
      console.log(`${list.id}: SKIPPED — no source file at ${path.relative(__dirname, missing)}`);
      continue;
    }

    // Re-read before each list so a company matched into the CRM by an earlier
    // list is found by a later one rather than inserted a second time.
    const existing = await Contact.find({}).lean();
    const index = indexExisting(existing);

    let created = 0, merged = 0, untouched = 0;
    const pending = [];

    for (const rec of records) {
      const hit = keysFor(rec).map(k => index.get(k)).find(Boolean);
      if (!hit) {
        const doc = newDoc(rec, list.id, now);
        pending.push({ insert: doc });
        // Index it immediately so two rows for the same firm inside one sheet
        // collapse into one record instead of racing each other.
        keysFor(doc).forEach(k => { if (!index.has(k)) index.set(k, doc); });
        created++;
        continue;
      }
      const diff = diffFor(hit, rec, list.id);
      if (!diff) { untouched++; continue; }
      if (hit._id) pending.push({ update: hit._id, diff });
      else {
        // Matched a document this same run is about to insert — fold the extra
        // detail into it rather than writing a second row.
        Object.assign(hit, diff.set);
        hit.tags = [...(hit.tags || []), ...diff.addTags];
        hit.lists = [...(hit.lists || []), ...diff.addList];
      }
      merged++;
    }

    if (!DRY) {
      const inserts = pending.filter(p => p.insert).map(p => p.insert);
      if (inserts.length) await Contact.insertMany(inserts, { ordered: false });
      for (const p of pending.filter(p => p.update)) {
        const op = { $set: { ...p.diff.set, updatedAt: now } };
        const add = {};
        if (p.diff.addTags.length) add.tags = { $each: p.diff.addTags };
        if (p.diff.addList.length) add.lists = { $each: p.diff.addList };
        if (Object.keys(add).length) op.$addToSet = add;
        await Contact.updateOne({ _id: p.update }, op);
      }
    }

    summary.push({ list: list.id, rows: records.length, created, merged, untouched });
    console.log(`${list.id}: ${records.length} rows → ${created} new, ${merged} merged into existing, ${untouched} already current`);
  }

  const total = summary.reduce((a, s) => ({
    rows: a.rows + s.rows, created: a.created + s.created, merged: a.merged + s.merged,
  }), { rows: 0, created: 0, merged: 0 });
  console.log(`\n${DRY ? '[dry run] ' : ''}${total.rows} rows across ${summary.length} lists → ${total.created} new contacts, ${total.merged} merged`);
  if (!DRY) console.log(`Contacts now in CRM: ${await Contact.countDocuments({})}`);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/probeAppLive',
    { serverSelectionTimeoutMS: 10000 });
  try {
    if (UNDO) await undo(); else await run();
  } finally {
    await mongoose.disconnect();
  }
})().catch(err => { console.error(err); process.exit(1); });

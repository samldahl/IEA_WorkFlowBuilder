// ── CRM module ───────────────────────────────────────────────────────────────
// Top-of-funnel contact tracking ("who we keep warm") → opportunity tracker →
// deal flow funnel timeline, plus email campaign / series drafting.
//
// Contacts originate in the IEA Field Portal. There is no live Field Portal API
// binding here, so records arrive one of three ways:
//   1. POST /crm/import   — paste or upload a Field Portal CSV / JSON export
//   2. POST /crm/contacts — manual entry in the app
//   3. Promotion of a qualified contact into an Opportunity
//
// Mounted by server.js as: app.use('/crm', crmRouter(authMiddleware, requireCrm))
// The CRM holds the client list and the live deal pipeline, so it is closed to
// the editor role: the gate passed in runs ahead of every route below.

const express = require('express');
const mongoose = require('mongoose');
const trackerSheet = require('./crm-tracker');
const sop = require('./crm-sop');
const lists = require('./crm-lists');
const { recordWrites } = require('./activity');

// ── Shared vocabulary ────────────────────────────────────────────────────────

// Top of funnel — where a relationship sits before it is a real deal
const FUNNEL_STAGES = [
  { id: 'unqualified', label: 'Unqualified',     short: 'Unqual',    cadence: 90 },
  { id: 'aware',       label: 'Aware / Touched', short: 'Aware',     cadence: 45 },
  { id: 'engaged',     label: 'Engaged',         short: 'Engaged',   cadence: 30 },
  { id: 'qualified',   label: 'Qualified',       short: 'Qualified', cadence: 14 },
];

// Opportunity tracker — the deal itself, fed by qualified contacts
const OPP_STAGES = [
  { id: 'identified', label: 'Identified',   prob: 10 },
  { id: 'qualifying', label: 'Qualifying',   prob: 25 },
  { id: 'proposal',   label: 'Proposal Out', prob: 50 },
  { id: 'verbal',     label: 'Verbal / PO',  prob: 80 },
  { id: 'won',        label: 'Won',          prob: 100 },
  { id: 'lost',       label: 'Lost',         prob: 0 },
];

// Delivery pipeline — mirrors STAGES in public/index.html. A won opportunity
// lands here, which is what joins the CRM to the discovered process flows.
const DELIVERY_STAGES = ['tofu', 'discovery', 'delivery', 'reporting', 'payment', 'followup'];

const DIVISIONS = ['EPDM', 'EHS', 'IAQ', 'ENG', 'ADMIN'];
const OFFICES = ['Brooklyn Park', 'Rochester', 'Mankato', 'Virginia & Brainerd', 'Marshall'];

const TOUCH_TYPES = [
  'call', 'email', 'site-visit', 'job-site', 'meeting',
  'event', 'proposal', 'linkedin', 'referral', 'note',
];

const CONTACT_STATUS = ['active', 'keep-warm', 'nurture', 'converted', 'dormant', 'do-not-contact'];

const WARMTH_TIERS = ['hot', 'warm', 'cooling', 'cold', 'dormant', 'excluded'];

const DAY = 86400000;

// ── Models ───────────────────────────────────────────────────────────────────

const Contact = mongoose.model('Contact', new mongoose.Schema({
  externalId:    { type: String, index: true },   // Field Portal record id
  firstName:     { type: String, default: '' },
  lastName:      { type: String, default: '' },
  title:         { type: String, default: '' },
  company:       { type: String, default: '', index: true },
  email:         { type: String, default: '', lowercase: true, trim: true, index: true },
  phone:         { type: String, default: '' },
  office:        { type: String, default: '' },   // IEA office owning the relationship
  divisions:     { type: [String], default: [] }, // services they buy / could buy
  owner:         { type: String, default: '' },   // IEA rep who keeps them warm
  source:        { type: String, default: 'field-portal' },
  funnelStage:   { type: String, default: 'unqualified', index: true },
  status:        { type: String, default: 'active', index: true },
  cadenceDays:   { type: Number, default: null }, // null → stage default
  lastTouchAt:   { type: Date,   default: null },
  lastTouchType: { type: String, default: '' },
  lastTouchNote: { type: String, default: '' },   // "what we saw them last"
  nextAction:    { type: String, default: '' },
  nextActionAt:  { type: Date,   default: null },
  sites:         { type: [String], default: [] }, // buildings / sites in Field Portal
  segment:       { type: String, default: '', index: true },  // K-12, Manufacturing, County, ...
  serviceAreas:  { type: [String], default: [] },             // EHS, ENG, IAQ, IH, HAZMAT, ENV
  tags:          { type: [String], default: [] },
  notes:         { type: String, default: '' },
  // ── Sales SOP ──────────────────────────────────────────────────────────────
  // Which of the four programme sources this lead came in on, and the timestamps
  // its response clocks run against. `capturedAt` is when we actually met them
  // or the inquiry landed; `loggedAt` is when it reached the tracker. The gap
  // between those two is the SOP's "entered within 2 business days" rule.
  leadSource:    { type: String, default: '', index: true },
  capturedAt:    { type: Date,   default: null },
  loggedAt:      { type: Date,   default: null },
  firstContactAt:{ type: Date,   default: null },
  respondedAt:   { type: Date,   default: null }, // they wrote back — stops the chase
  eventName:     { type: String, default: '' },   // the show or meeting we met at
  // Retention programme tiering. This drives the check-in cadence for anyone who
  // is already a client, in place of the top-of-funnel stage cadence.
  clientTier:    { type: String, default: '', index: true },
  lastProjectAt: { type: Date,   default: null }, // project completion → 14-day check-in
  // Strategic criteria a person ticked by hand. The derived set is computed from
  // segment, title and service mix, and these merge on top so a judgement call
  // is never overwritten by inference.
  strategicManual: { type: [String], default: [] },
  newTarget:     { type: Boolean, default: false },
  // Source lists this contact belongs to — see crm-lists.js. A contact can sit
  // on several, which is how the Top 30 stays a visible subset of the Top 100.
  lists:         { type: [String], default: [], index: true },
  // A last-touch date recovered from a year-only column is an estimate, and the
  // UI says so rather than presenting it as a logged touch.
  lastTouchEstimated: { type: Boolean, default: false },
  createdAt:     { type: Date, default: Date.now },
  updatedAt:     { type: Date, default: Date.now },
}));

const Opportunity = mongoose.model('Opportunity', new mongoose.Schema({
  name:            { type: String, required: true },
  externalId:      { type: String, default: null, index: true }, // tracker row identity
  description:     { type: String, default: '' },
  contactId:       { type: String, default: null, index: true },
  company:         { type: String, default: '' },
  division:        { type: String, default: '' },
  office:          { type: String, default: '' },
  owner:           { type: String, default: '' },
  stage:           { type: String, default: 'identified', index: true },
  value:           { type: Number, default: 0 },
  probability:     { type: Number, default: null }, // null → stage default
  expectedCloseAt: { type: Date,   default: null },
  flowId:          { type: String, default: null }, // links to a discovered flow
  deliveryStage:   { type: String, default: null }, // where a won deal sits in delivery
  nextAction:      { type: String, default: '' },
  nextActionAt:    { type: Date,   default: null },
  lostReason:      { type: String, default: '' },
  // Columns carried straight over from the Ops Tracker sheet
  segment:         { type: String, default: '', index: true },
  serviceAreas:    { type: [String], default: [] },
  source:          { type: String, default: '', index: true },
  sourceRaw:       { type: String, default: '' },
  referralName:    { type: String, default: '' },
  originator:      { type: String, default: '' },
  opsManager:      { type: String, default: '' },
  proposalSent:    { type: Boolean, default: null },
  statusUpdate:    { type: String, default: '' },
  csiUpdate:       { type: String, default: '' },
  notes:           { type: String, default: '' },
  // ── Sales SOP ──────────────────────────────────────────────────────────────
  // `source` stays as the tracker's own granular channel; `leadSource` is the
  // programme's four-way classification, which is what the monthly review and
  // the response clocks are written against.
  leadSource:      { type: String, default: '', index: true },
  strategicManual: { type: [String], default: [] },
  newTarget:       { type: Boolean, default: false },
  // Proposal follow-up ladder. The send date drives the 14 / 21 / 28-day steps;
  // choosing an escalation path stops the ladder because the deal is being
  // worked rather than drifting.
  proposalSentAt:  { type: Date,   default: null },
  escalationPath:  { type: String, default: '' },  // '' | 'csi' | 'client-facing'
  escalatedAt:     { type: Date,   default: null },
  escalationNote:  { type: String, default: '' },
  // Archive: won, lost, 12 months idle, or no longer viable.
  archived:        { type: Boolean, default: false, index: true },
  archivedAt:      { type: Date,   default: null },
  archiveReason:   { type: String, default: '' },
  lists:           { type: [String], default: [], index: true },
  // Stage transitions — this array is what draws the deal flow funnel timeline
  history:         { type: [{ stage: String, at: Date, by: String, note: String }], default: [] },
  openedAt:        { type: Date, default: Date.now },
  closedAt:        { type: Date, default: null },
  updatedAt:       { type: Date, default: Date.now },
}));

const Touch = mongoose.model('Touch', new mongoose.Schema({
  contactId:     { type: String, index: true },
  opportunityId: { type: String, default: null },
  type:          { type: String, default: 'note' },
  at:            { type: Date, default: Date.now, index: true },
  note:          { type: String, default: '' },
  username:      { type: String, default: '' },
  displayName:   { type: String, default: '' },
}));

const Campaign = mongoose.model('Campaign', new mongoose.Schema({
  name:   { type: String, required: true },
  goal:   { type: String, default: '' },
  status: { type: String, default: 'draft' }, // draft | active | paused
  // Who it targets — evaluated against contacts to build the send list
  audience: {
    funnelStages: { type: [String], default: [] },
    warmth:       { type: [String], default: [] },
    divisions:    { type: [String], default: [] },
    offices:      { type: [String], default: [] },
    statuses:     { type: [String], default: [] },
    tags:         { type: [String], default: [] },
    segments:     { type: [String], default: [] },   // K-12, Manufacturing, County, ...
    serviceAreas: { type: [String], default: [] },   // EHS, ENG, IAQ, IH, HAZMAT, ENV
  },
  // The series: one email per step, offset in days from enrollment
  steps: {
    type: [{
      dayOffset: Number,
      channel:   String,
      subject:   String,
      body:      String,
      stopIf:    String, // e.g. 'replied', 'meeting-booked', 'opportunity-created'
    }],
    default: [],
  },
  createdBy: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}));

// ── Warmth ───────────────────────────────────────────────────────────────────
// "Who we keep warm" is the whole point, so warmth is derived: how far past the
// intended touch cadence a contact has drifted, not a label someone forgets to
// update. Logging a touch is the only thing that resets it.

function cadenceFor(contact) {
  if (contact.cadenceDays) return contact.cadenceDays;
  // The retention programme's rhythm outranks the funnel's. Once someone is a
  // client, "qualified, so touch every 14 days" is the wrong question — the
  // programme says Strategic quarterly, Active semi-annually, Dormant quarterly.
  const tierCadence = sop.retentionCadence(contact);
  if (tierCadence) return tierCadence;
  if (contact.status === 'keep-warm') return 60;
  if (contact.status === 'nurture') return 90;
  const stage = FUNNEL_STAGES.find(s => s.id === contact.funnelStage);
  return stage ? stage.cadence : 60;
}

// Why a contact is on the cadence it is on, so the UI can say so rather than
// showing a bare number nobody can account for.
function cadenceSource(contact) {
  if (contact.cadenceDays) return 'Set by hand on this contact';
  const tier = sop.tierFor(contact.clientTier);
  if (tier && tier.cadence) return `${tier.label} client — ${tier.rhythm.toLowerCase()} check-in`;
  if (contact.status === 'keep-warm') return 'Keep-warm status';
  if (contact.status === 'nurture') return 'Nurture status';
  const stage = FUNNEL_STAGES.find(s => s.id === contact.funnelStage);
  return stage ? `${stage.label} funnel stage` : 'Default';
}

function warmthFor(contact, now) {
  now = now || Date.now();
  // A recorded first contact is a touch, even where no Touch row exists for it
  // — the lists arrive carrying "sent initial email 9/8" and nothing else.
  // Without this the same contact reads "never contacted" beside a first-contact
  // clock that is satisfied, which is not a thing anyone should have to resolve.
  const anchor = contact.lastTouchAt || contact.firstContactAt || contact.createdAt || now;
  const daysSince = Math.max(0, Math.floor((now - new Date(anchor).getTime()) / DAY));
  const cadence = cadenceFor(contact);
  const ratio = cadence > 0 ? daysSince / cadence : 99;
  let tier;
  if (contact.status === 'do-not-contact') tier = 'excluded';
  else if (ratio <= 0.5) tier = 'hot';
  else if (ratio <= 1)   tier = 'warm';
  else if (ratio <= 1.5) tier = 'cooling';
  else if (ratio <= 3)   tier = 'cold';
  else                   tier = 'dormant';
  return {
    tier,
    daysSince,
    cadence,
    ratio: Math.round(ratio * 100) / 100,
    overdueDays: Math.max(0, daysSince - cadence),
    dueAt: new Date(new Date(anchor).getTime() + cadence * DAY),
    neverTouched: !contact.lastTouchAt && !contact.firstContactAt,
  };
}

const WARMTH_ORDER = { dormant: 0, cold: 1, cooling: 2, warm: 3, hot: 4, excluded: 5 };

function decorate(contact, now) {
  const c = contact.toObject ? contact.toObject() : { ...contact };
  c.warmth = warmthFor(c, now);
  c.warmth.basis = cadenceSource(c);
  // A prospect sheet row is a company we have not yet found a person at, so the
  // company is its name. Falling through to "(unnamed)" made a whole target
  // list unreadable.
  c.fullName = [c.firstName, c.lastName].filter(Boolean).join(' ').trim() ||
    c.email || c.company || '(unnamed)';
  // SOP derivations — the response clocks, the post-project check-in, and
  // whether this lead meets the Strategic criteria on its own evidence.
  c.sla = sop.leadSla(c, now);
  c.projectFollowUp = sop.projectFollowUp(c, now);
  // The programme says "a lead is Strategic if…", so the criteria are derived
  // for leads — anyone on one of the four programme sources — and for anyone
  // somebody has ticked by hand. Deriving them across the whole contact book
  // would mark every healthcare and manufacturing account strategic and drain
  // the word of any meaning. An existing client's importance is carried by
  // their retention tier instead, which is a different programme's idea.
  const isLead = !!c.leadSource;
  c.strategicReasons = (isLead || (c.strategicManual || []).length)
    ? sop.strategicReasons(c, c.strategicManual)
    : [];
  c.strategic = c.strategicReasons.length > 0;
  return c;
}

// The opportunity equivalent. Three of the SOPs land here: the Simple Success
// Rule, the proposal follow-up ladder, and the archive rule.
function decorateOpp(opp, now) {
  const o = opp.toObject ? opp.toObject() : { ...opp };
  o.probability = probabilityOf(o);
  o.successRule = sop.successRule(o);
  o.proposal = sop.proposalWatch(o, now);
  o.archive = sop.archiveCheck(o, now);
  o.strategicReasons = sop.strategicReasons(o, o.strategicManual);
  o.strategic = o.strategicReasons.length > 0;
  // One flag for "this row needs a human now", which is what the review views
  // and the board badges sort on.
  o.needsReview = !o.successRule.ok || !!(o.proposal && o.proposal.needsAttention);
  return o;
}

// ── Field Portal import ──────────────────────────────────────────────────────
// Field Portal exports vary by report, so headers are matched loosely rather
// than demanding one exact column set.

const FIELD_ALIASES = {
  externalId: ['id', 'record id', 'contact id', 'portal id', 'external id', 'recordid'],
  firstName:  ['first name', 'firstname', 'first', 'given name'],
  lastName:   ['last name', 'lastname', 'last', 'surname', 'family name'],
  fullName:   ['name', 'full name', 'contact', 'contact name'],
  title:      ['title', 'job title', 'position', 'role'],
  company:    ['company', 'account', 'organization', 'org', 'client', 'customer', 'account name', 'company name'],
  email:      ['email', 'e mail', 'email address', 'primary email'],
  phone:      ['phone', 'telephone', 'mobile', 'cell', 'phone number', 'primary phone'],
  office:     ['office', 'branch', 'location', 'iea office'],
  owner:      ['owner', 'rep', 'account manager', 'assigned to', 'sales rep', 'pm'],
  divisions:  ['division', 'divisions', 'service line', 'services', 'business unit'],
  source:     ['source', 'lead source', 'origin', 'channel'],
  funnelStage:['stage', 'funnel stage', 'lifecycle stage', 'status stage'],
  status:     ['status', 'contact status', 'relationship status'],
  lastTouchAt:['last contact', 'last touch', 'last activity', 'last contacted', 'last seen',
               'last activity date', 'last contact date'],
  lastTouchType: ['last activity type', 'last touch type', 'activity type'],
  lastTouchNote: ['last note', 'notes from last contact', 'last activity note'],
  sites:      ['site', 'sites', 'building', 'buildings', 'property', 'facility'],
  tags:       ['tags', 'labels', 'keywords'],
  notes:      ['notes', 'comments', 'description', 'remarks'],
};

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ');
}

function buildHeaderMap(headers) {
  const map = {};
  headers.forEach((raw, i) => {
    const h = normalizeHeader(raw);
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (map[field] === undefined && aliases.includes(h)) { map[field] = i; break; }
    }
  });
  return map;
}

// Minimal RFC-4180 CSV parser — handles quoted fields and embedded commas/newlines.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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

function splitList(v) {
  return String(v || '').split(/[;,|/]+/).map(s => s.trim()).filter(Boolean);
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// Match a free-text export value against a known list, by id or by label.
function matchOption(value, options, fallback) {
  const v = normalizeHeader(value);
  if (!v) return fallback;
  const hit = options.find(o =>
    normalizeHeader(o.id || o) === v ||
    normalizeHeader(o.label || o) === v ||
    normalizeHeader(o.short || o) === v);
  return hit ? (hit.id || hit) : fallback;
}

// Map one export row onto a Contact. Unrecognized stage/status values fall back
// to safe defaults rather than poisoning the funnel counts.
function rowToContact(get) {
  const c = {
    externalId:    get('externalId'),
    title:         get('title'),
    company:       get('company'),
    email:         get('email').toLowerCase().trim(),
    phone:         get('phone'),
    owner:         get('owner'),
    notes:         get('notes'),
    lastTouchType: get('lastTouchType'),
    lastTouchNote: get('lastTouchNote'),
    divisions:     splitList(get('divisions')).map(d => d.toUpperCase()).filter(d => DIVISIONS.includes(d)),
    sites:         splitList(get('sites')),
    tags:          splitList(get('tags')),
    source:        get('source') || 'field-portal',
    lastTouchAt:   parseDate(get('lastTouchAt')),
    office:        matchOption(get('office'), OFFICES, ''),
    funnelStage:   matchOption(get('funnelStage'), FUNNEL_STAGES, 'unqualified'),
    status:        matchOption(get('status'), CONTACT_STATUS, 'active'),
  };

  const first = get('firstName'), last = get('lastName'), full = get('fullName');
  if (first || last) {
    c.firstName = first;
    c.lastName = last;
  } else if (full.includes(',')) {
    // Field Portal name columns are often "Last, First"
    const [lastPart, ...rest] = full.split(',');
    c.lastName = lastPart.trim();
    c.firstName = rest.join(',').trim();
  } else if (full) {
    const parts = full.trim().split(/\s+/);
    c.firstName = parts.shift() || '';
    c.lastName = parts.join(' ');
  }

  return c;
}

// ── Email drafting ───────────────────────────────────────────────────────────
// Templates are picked from what we actually know about a person: how cold they
// have gone, what we last did with them, which division they buy, and whether a
// deal is already open. Every draft is editable — nothing sends from here.

const DIV_SERVICE = {
  EPDM:  'asbestos & hazmat work',
  EHS:   'safety compliance and OSHA readiness',
  IAQ:   'indoor air quality and industrial hygiene',
  ENG:   'ventilation and engineering assessments',
  ADMIN: 'program administration',
};

function divPhrase(divs) {
  const parts = (divs || []).map(d => DIV_SERVICE[d]).filter(Boolean);
  if (!parts.length) return 'environmental and safety work';
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

// Two shapes for the same gap: "11 months" reads correctly after "it has been",
// "11 months ago" after "we spoke". Mixing them produced "11 months ago since".
function durationPhrase(days) {
  if (days <= 0) return 'less than a day';
  if (days === 1) return 'a day';
  if (days < 14) return `${days} days`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  if (days < 730) return `${Math.round(days / 30)} months`;
  return `over ${Math.floor(days / 365)} years`;
}

function agoPhrase(days) {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return durationPhrase(days) + ' ago';
}

function lower(s) {
  const t = String(s || '').trim().replace(/\.$/, '');
  return t.charAt(0).toLowerCase() + t.slice(1);
}

function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function signoff(c, signer) {
  return `— ${c.owner || signer || 'IEA'}\nIEA Safety`;
}

const TEMPLATES = [
  {
    id: 'post-visit',
    label: 'Post site visit follow-up',
    when: c => ['site-visit', 'job-site', 'meeting'].includes(c.lastTouchType) && c.warmth.daysSince <= 14,
    subject: c => `Following up on ${c.sites[0] || c.company || 'our walkthrough'}`,
    body: c => [
      `Hi ${c.firstName || 'there'},`, '',
      `Thanks for the time ${agoPhrase(c.warmth.daysSince)} at ${c.sites[0] || c.company || 'your site'}.`,
      c.lastTouchNote ? `You mentioned ${lower(c.lastTouchNote)} — that is squarely the kind of thing we handle.` : null,
      '',
      `I pulled together what the next step looks like on our side${c.divisions.length ? ` for ${divPhrase(c.divisions)}` : ''}. Worth a short call this week?`,
      '', signoff(c, c._signer),
    ].filter(x => x !== null).join('\n'),
  },
  {
    id: 'proposal-followup',
    label: 'Proposal follow-up',
    when: (c, opp) => !!opp && ['proposal', 'verbal'].includes(opp.stage),
    subject: (c, opp) => `Checking in on ${opp ? opp.name : 'the proposal'}`,
    body: (c, opp) => [
      `Hi ${c.firstName || 'there'},`, '',
      `Wanted to check where things landed on ${opp ? opp.name : 'the proposal we sent'}.`,
      opp && opp.value ? `Scope as written comes in around ${money(opp.value)} — happy to adjust if the scope has moved.` : null,
      '',
      `Any questions I can answer, or anyone else on your side I should walk through it with?`,
      '', signoff(c, c._signer),
    ].filter(x => x !== null).join('\n'),
  },
  {
    id: 'reengage',
    label: 'Re-engagement (gone cold)',
    when: c => ['cold', 'dormant'].includes(c.warmth.tier) && !c.warmth.neverTouched,
    subject: c => `Still the right contact at ${c.company || 'your team'}?`,
    body: c => [
      `Hi ${c.firstName || 'there'},`, '',
      `It has been ${durationPhrase(c.warmth.daysSince)} since we last connected${c.lastTouchNote ? ` — last time it was about ${lower(c.lastTouchNote)}` : ''}.`,
      '',
      `Two quick things: are you still the right person for ${divPhrase(c.divisions)} at ${c.company || 'your organization'}, and is anything coming up this year we should be scoping now?`,
      '',
      `If it is a no on both, say the word and I will stop filling your inbox.`,
      '', signoff(c, c._signer),
    ].filter(x => x !== null).join('\n'),
  },
  {
    id: 'qualified-nudge',
    label: 'Qualified — push to scope',
    when: c => c.funnelStage === 'qualified',
    subject: c => `Next step on ${c.divisions.length ? divPhrase(c.divisions) : 'the scope we discussed'}`,
    body: c => [
      `Hi ${c.firstName || 'there'},`, '',
      `Based on where we left off, the next step is a scoping call so we can put real numbers against ${divPhrase(c.divisions)}.`,
      c.lastTouchNote ? `Specifically around ${lower(c.lastTouchNote)}.` : null,
      '',
      `Thirty minutes this week or next? I will come with a draft scope so we are reacting to something concrete.`,
      '', signoff(c, c._signer),
    ].filter(x => x !== null).join('\n'),
  },
  {
    id: 'annual-renewal',
    label: 'Annual / recurring service',
    when: c => (c.tags || []).some(t => /annual|recurring|surveillance|periodic/i.test(t)),
    subject: c => `Scheduling this year's ${c.divisions.length ? divPhrase(c.divisions) : 'recurring work'}`,
    body: c => [
      `Hi ${c.firstName || 'there'},`, '',
      `We are building the schedule for the coming cycle and wanted to get ${c.company || 'you'} on the calendar before it fills.`,
      c.sites.length ? `Same scope at ${c.sites.slice(0, 3).join(', ')}, or has anything changed?` : `Same scope as last cycle, or has anything changed?`,
      '',
      `Send me a couple of windows that work and I will lock it in.`,
      '', signoff(c, c._signer),
    ].filter(x => x !== null).join('\n'),
  },
  {
    id: 'intro',
    label: 'First touch / introduction',
    when: c => c.warmth.neverTouched,
    subject: c => `${c.company || 'Your team'} — environmental & safety support`,
    body: c => [
      `Hi ${c.firstName || 'there'},`, '',
      `I am reaching out from IEA. We handle ${c.divisions.length ? divPhrase(c.divisions) : 'asbestos and hazmat, industrial hygiene, indoor air quality, and safety compliance'} for organizations across Minnesota.`,
      '',
      `I do not know yet whether any of that is relevant to ${c.company || 'you'} — that is really the question. Is environmental or safety compliance something you own, or should I be talking to someone else?`,
      '', signoff(c, c._signer),
    ].filter(x => x !== null).join('\n'),
  },
  {
    id: 'referral-ask',
    label: 'Referral ask (converted client)',
    when: c => c.status === 'converted',
    subject: () => `A quick ask`,
    body: c => [
      `Hi ${c.firstName || 'there'},`, '',
      `Work on our side has been going well${c.sites.length ? ` at ${c.sites[0]}` : ''}, and I wanted to ask something rather than sell something.`,
      '',
      `Is there anyone else in your network — another facility, another property manager — dealing with the same compliance pressure? A short introduction goes a long way.`,
      '', signoff(c, c._signer),
    ].filter(x => x !== null).join('\n'),
  },
  {
    id: 'keep-warm-checkin',
    label: 'Keep-warm check-in',
    when: () => true, // fallback — always last in the list
    subject: c => `Quick check-in${c.company ? ` — ${c.company}` : ''}`,
    body: c => [
      `Hi ${c.firstName || 'there'},`, '',
      `No agenda here — just keeping our end of the line open.`,
      c.lastTouchNote
        ? `When we last spoke you were working through ${lower(c.lastTouchNote)}. Where did that end up?`
        : `How is the year shaping up on your side?`,
      '',
      c.sites.length
        ? `If anything has come up at ${c.sites.slice(0, 2).join(' or ')}, we can usually get someone out inside a week.`
        : `If anything comes up, we can usually get someone out inside a week.`,
      '', signoff(c, c._signer),
    ].filter(x => x !== null).join('\n'),
  },
];

// Why this template, in the words a rep would use — so the draft can be trusted
// or overridden rather than taken on faith.
function draftRationale(c, opp, tpl) {
  const bits = [`${c.warmth.tier}: ${c.warmth.neverTouched ? 'never touched' : `${c.warmth.daysSince}d since last touch`}, ${c.warmth.cadence}d cadence`];
  if (c.lastTouchType) bits.push(`last touch was a ${c.lastTouchType}`);
  if (opp) bits.push(`open opportunity at ${opp.stage}`);
  bits.push(`funnel stage ${c.funnelStage}`);
  return `${tpl.label} — ${bits.join('; ')}.`;
}

function draftFor(contact, opp, templateId, signer) {
  contact._signer = signer || '';
  const tpl = templateId ? TEMPLATES.find(t => t.id === templateId) : null;
  const chosen = tpl
    || TEMPLATES.find(t => { try { return t.when(contact, opp); } catch { return false; } })
    || TEMPLATES[TEMPLATES.length - 1];
  delete contact._signer;
  return {
    templateId: chosen.id,
    templateLabel: chosen.label,
    to: contact.email,
    subject: chosen.subject(contact, opp),
    body: chosen.body(contact, opp),
    rationale: draftRationale(contact, opp, chosen),
  };
}

// Merge fields available to campaign step authors.
const MERGE_FIELDS = [
  'first_name', 'last_name', 'full_name', 'company', 'title', 'owner', 'office',
  'last_touch', 'last_touch_type', 'days_since', 'time_ago', 'duration_since', 'sites', 'services',
  'opp_name', 'opp_value', 'opp_stage',
];

function merge(text, c, opp, signer) {
  if (signer && !c._signer) c._signer = signer;
  const vals = {
    first_name:      c.firstName || 'there',
    last_name:       c.lastName || '',
    full_name:       c.fullName || '',
    company:         c.company || 'your organization',
    title:           c.title || '',
    owner:           c.owner || c._signer || 'IEA',
    office:          c.office || '',
    last_touch:      c.lastTouchNote || 'our last conversation',
    last_touch_type: c.lastTouchType || 'conversation',
    days_since:      String(c.warmth ? c.warmth.daysSince : ''),
    time_ago:        c.warmth ? agoPhrase(c.warmth.daysSince) : '',
    duration_since:  c.warmth ? durationPhrase(c.warmth.daysSince) : '',
    sites:           (c.sites || []).slice(0, 3).join(', '),
    services:        divPhrase(c.divisions),
    opp_name:        opp ? opp.name : '',
    opp_value:       opp ? money(opp.value) : '',
    opp_stage:       opp ? opp.stage : '',
  };
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vals[k] !== undefined ? vals[k] : m));
}

function probabilityOf(opp) {
  if (opp.probability != null) return opp.probability;
  const stage = OPP_STAGES.find(s => s.id === opp.stage);
  return stage ? stage.prob : 0;
}

function pick(obj, keys) {
  const out = {};
  keys.forEach(k => { if (obj[k] !== undefined) out[k] = obj[k]; });
  return out;
}

// ── Router ───────────────────────────────────────────────────────────────────

// Turns a CRM write into one line for the admin activity feed. Returning null
// skips the request — reads and no-op calls are not worth recording.
function describeCrmWrite(req, body) {
  const seg = req.path.split('/').filter(Boolean);   // e.g. ['contacts', '<id>', 'touch']
  const entity = (seg[0] || 'record').replace(/s$/, '');
  const id = seg[1] || (body && body._id ? String(body._id) : '');
  const nameOf = (b) => {
    if (!b || typeof b !== 'object') return '';
    if (b.name) return b.name;                 // opportunities and campaigns are already named
    const person = b.fullName || [b.firstName, b.lastName].filter(Boolean).join(' ');
    // A person's name on its own is not enough to recognise in a feed, and a
    // search for the client should find the touch logged against their contact.
    if (person && b.company && person !== b.company) return person + ' (' + b.company + ')';
    return person || b.company || b.email || '';
  };

  if (seg[2] === 'touch')
    return { action: 'touch', entity: 'contact', entityId: id, label: nameOf(body),
             detail: 'Logged a ' + ((req.body && req.body.type) || 'note') };

  if (seg[0] === 'import' || seg[0] === 'import-tracker')
    return { action: 'import', entity: 'contact', label: 'CSV import',
             detail: body ? `${body.created || 0} added, ${body.updated || 0} updated` : 'Import run' };

  if (seg[1] === 'generate')
    return { action: 'generate', entity: 'campaign', entityId: seg[0] === 'campaigns' ? id : '',
             label: nameOf(body), detail: 'Generated campaign emails' };

  if (seg[0] === 'draft') return null;   // drafting text changes nothing

  const action = req.method === 'POST' ? 'create' : req.method === 'DELETE' ? 'delete' : 'update';
  const label = nameOf(body) || nameOf(req.body) || entity;
  const detail = action === 'create' ? `Added ${entity}`
               : action === 'delete' ? `Deleted ${entity}`
               : `Edited ${entity}`;
  return { action, entity, entityId: id, label, detail };
}

module.exports = function crmRouter(authMiddleware, requireCrm) {
  const router = express.Router();
  router.use(authMiddleware);
  // Gating here rather than in the UI means hiding the tab is a convenience,
  // not the control.
  if (requireCrm) router.use(requireCrm);
  router.use(recordWrites('crm', describeCrmWrite));

  // Vocabulary, so the UI never keeps a second copy of the stage lists
  router.get('/meta', (req, res) => {
    res.json({
      funnelStages: FUNNEL_STAGES,
      oppStages: OPP_STAGES,
      deliveryStages: DELIVERY_STAGES,
      divisions: DIVISIONS,
      offices: OFFICES,
      touchTypes: TOUCH_TYPES,
      contactStatus: CONTACT_STATUS,
      warmthTiers: WARMTH_TIERS,
      mergeFields: MERGE_FIELDS,
      templates: TEMPLATES.map(t => ({ id: t.id, label: t.label })),
      serviceAreas: trackerSheet.SERVICE_AREAS.map(s => ({ id: s.code, label: s.label })),
      sources: trackerSheet.SOURCES.map(s => ({ id: s.code, label: s.label })),
      segments: trackerSheet.SEGMENTS.map(s => ({ id: s.code, label: s.label })),
      // Sales SOP vocabulary, so the page states the programme's own rules
      // rather than paraphrasing them.
      leadSources: sop.LEAD_SOURCES,
      strategicCriteria: sop.STRATEGIC_CRITERIA,
      clientTiers: sop.CLIENT_TIERS,
      escalationPaths: sop.ESCALATION_PATHS,
      archiveReasons: sop.ARCHIVE_REASONS,
      proposalSla: sop.PROPOSAL_SLA,
      successFields: sop.SUCCESS_FIELDS,
      projectFollowUpDays: sop.PROJECT_FOLLOWUP_DAYS,
      archiveAfterDays: sop.ARCHIVE_AFTER_DAYS,
      lists: lists.LISTS.map(l => ({
        id: l.id, label: l.label, group: l.group, blurb: l.blurb,
        file: l.file, sheet: l.sheet || null, subsetOf: l.subsetOf || null,
      })),
    });
  });

  // ── Contacts ───────────────────────────────────────────────────────────────

  router.get('/contacts', async (req, res) => {
    try {
      const q = {};
      if (req.query.stage)    q.funnelStage = req.query.stage;
      if (req.query.status)   q.status = req.query.status;
      if (req.query.office)   q.office = req.query.office;
      if (req.query.owner)    q.owner = req.query.owner;
      if (req.query.division) q.divisions = req.query.division;
      // `list=none` is how the page asks for everything that predates Amy's
      // sheets — the contacts already in the CRM, not on any imported list.
      if (req.query.list === 'none') q.lists = { $size: 0 };
      else if (req.query.list)  q.lists = req.query.list;
      if (req.query.tier)       q.clientTier = req.query.tier;
      if (req.query.leadSource) q.leadSource = req.query.leadSource;
      if (req.query.q) {
        const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        q.$or = [{ firstName: rx }, { lastName: rx }, { company: rx }, { email: rx }, { sites: rx }, { tags: rx }];
      }
      const now = Date.now();
      let contacts = (await Contact.find(q).lean()).map(c => decorate(c, now));
      if (req.query.warmth) {
        const want = String(req.query.warmth).split(',');
        contacts = contacts.filter(c => want.includes(c.warmth.tier));
      }
      if (req.query.strategic === 'true') contacts = contacts.filter(c => c.strategic);
      // Anything breaching one of the programme's response clocks.
      if (req.query.slaBreach === 'true') contacts = contacts.filter(c => c.sla && c.sla.breaches.length);
      // Coldest first — this list is a work queue, not an address book
      contacts.sort((a, b) =>
        (WARMTH_ORDER[a.warmth.tier] - WARMTH_ORDER[b.warmth.tier]) ||
        (b.warmth.overdueDays - a.warmth.overdueDays));
      res.json(contacts);
    } catch (err) {
      console.error('GET /crm/contacts', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/contacts', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.firstName && !body.lastName && !body.company && !body.email)
        return res.status(400).json({ error: 'Need at least a name, company, or email' });
      const contact = await Contact.create({ ...body, updatedAt: new Date() });
      res.json(decorate(contact));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/contacts/:id', async (req, res) => {
    try {
      const body = { ...(req.body || {}), updatedAt: new Date() };
      delete body._id;
      delete body.warmth;
      delete body.fullName;
      const contact = await Contact.findByIdAndUpdate(req.params.id, body, { new: true });
      if (!contact) return res.status(404).json({ error: 'Not found' });
      res.json(decorate(contact));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/contacts/:id', async (req, res) => {
    try {
      await Contact.findByIdAndDelete(req.params.id);
      await Touch.deleteMany({ contactId: req.params.id });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Log a touch — the one action that resets warmth
  router.post('/contacts/:id/touch', async (req, res) => {
    try {
      const { type, note, at } = req.body || {};
      const contact = await Contact.findById(req.params.id);
      if (!contact) return res.status(404).json({ error: 'Not found' });
      const when = parseDate(at) || new Date();
      await Touch.create({
        contactId: String(contact._id),
        type: type || 'note',
        note: note || '',
        at: when,
        username: req.user.username,
        displayName: req.user.displayName,
      });
      // Only move the warmth anchor forward — backdating an older touch should
      // not make a contact look colder than the most recent one already logged.
      if (!contact.lastTouchAt || when >= contact.lastTouchAt) {
        contact.lastTouchAt = when;
        contact.lastTouchType = type || 'note';
        if (note) contact.lastTouchNote = note;
      }
      contact.updatedAt = new Date();
      await contact.save();
      res.json(decorate(contact));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/contacts/:id/touches', async (req, res) => {
    try {
      const touches = await Touch.find({ contactId: req.params.id }).sort({ at: -1 }).limit(100).lean();
      res.json(touches);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Field Portal import ────────────────────────────────────────────────────
  // Accepts { csv } or { rows: [...] }. Upserts on externalId, then email, so
  // re-importing a refreshed export updates rather than duplicates.

  router.post('/import', async (req, res) => {
    try {
      const { csv, rows, defaults } = req.body || {};
      let records = [];

      if (csv) {
        const parsed = parseCsv(csv);
        if (parsed.length < 2)
          return res.status(400).json({ error: 'CSV needs a header row and at least one data row' });
        const map = buildHeaderMap(parsed[0]);
        if (!Object.keys(map).length)
          return res.status(400).json({ error: 'No recognizable columns. Expected headers like Name, Company, Email, Last Contact.' });
        records = parsed.slice(1).map(r =>
          rowToContact(f => (map[f] != null ? String(r[map[f]] ?? '').trim() : '')));
      } else if (Array.isArray(rows)) {
        records = rows.map(obj => {
          const lookup = {};
          Object.keys(obj).forEach(k => { lookup[normalizeHeader(k)] = obj[k]; });
          const map = {};
          for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
            const hit = aliases.find(a => lookup[a] !== undefined);
            if (hit) map[field] = hit;
          }
          return rowToContact(f => (map[f] != null ? String(lookup[map[f]] ?? '').trim() : ''));
        });
      } else {
        return res.status(400).json({ error: 'Provide csv text or a rows array' });
      }

      const d = defaults || {};
      let created = 0, updated = 0, skipped = 0;

      for (const rec of records) {
        if (!rec.email && !rec.company && !rec.firstName && !rec.lastName) { skipped++; continue; }
        if (d.office && !rec.office) rec.office = d.office;
        if (d.owner && !rec.owner) rec.owner = d.owner;
        if (d.status) rec.status = d.status;
        if (Array.isArray(d.divisions) && d.divisions.length && !rec.divisions.length) rec.divisions = d.divisions;

        const or = [];
        if (rec.externalId) or.push({ externalId: rec.externalId });
        if (rec.email) or.push({ email: rec.email });
        const existing = or.length ? await Contact.findOne({ $or: or }) : null;

        if (existing) {
          // A refreshed export should fill gaps and advance the last-touch date,
          // not wipe notes a rep typed in the app.
          Object.entries(rec).forEach(([k, v]) => {
            if (v === '' || v == null) return;
            if (Array.isArray(v) && !v.length) return;
            if (k === 'lastTouchAt' && existing.lastTouchAt && v < existing.lastTouchAt) return;
            existing[k] = v;
          });
          existing.updatedAt = new Date();
          await existing.save();
          updated++;
        } else {
          await Contact.create({ ...rec, updatedAt: new Date() });
          created++;
        }
      }

      res.json({ ok: true, created, updated, skipped, total: records.length });
    } catch (err) {
      console.error('POST /crm/import', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Opportunity Tracker import ─────────────────────────────────────────────
  // Each row of the live Ops Tracker sheet becomes a linked Contact +
  // Opportunity. Re-importing a refreshed export updates in place rather than
  // duplicating, and never clobbers a note typed in the app with a blank cell.

  router.post('/import-tracker', async (req, res) => {
    try {
      const { csv } = req.body || {};
      if (!csv) return res.status(400).json({ error: 'Paste the Opportunity Tracker CSV export' });

      let parsed;
      try {
        parsed = trackerSheet.parseTracker(parseCsv, csv);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }

      let contactsCreated = 0, contactsUpdated = 0, oppsCreated = 0, oppsUpdated = 0;

      for (const rec of parsed.records) {
        // Contact: match the tracker identity first, then fall back to email
        const or = [{ externalId: rec.contact.externalId }];
        if (rec.contact.email) or.push({ email: rec.contact.email });
        let contact = await Contact.findOne({ $or: or });

        if (contact) {
          Object.entries(rec.contact).forEach(([k, v]) => {
            if (v === '' || v == null) return;
            if (Array.isArray(v) && !v.length) return;
            if (k === 'lastTouchAt' && contact.lastTouchAt && v < contact.lastTouchAt) return;
            contact[k] = v;
          });
          contact.updatedAt = new Date();
          await contact.save();
          contactsUpdated++;
        } else {
          contact = await Contact.create({ ...rec.contact, updatedAt: new Date() });
          contactsCreated++;
        }

        const opp = { ...rec.opportunity, contactId: String(contact._id) };
        opp.externalId = rec.contact.externalId + '|' + opp.description.toLowerCase().slice(0, 60);

        const existing = await Opportunity.findOne({ externalId: opp.externalId });
        if (existing) {
          const stageChanged = existing.stage !== opp.stage;
          Object.assign(existing, opp);
          if (stageChanged)
            existing.history.push({ stage: opp.stage, at: opp.updatedAt || new Date(),
                                    by: req.user.displayName, note: 'Updated from tracker import' });
          await existing.save();
          oppsUpdated++;
        } else {
          await Opportunity.create({
            ...opp,
            // Seed the timeline with what the sheet records: opened, and where it is now
            history: [
              { stage: 'identified', at: opp.openedAt || opp.updatedAt || new Date(),
                by: opp.originator || 'Tracker', note: 'Logged in Ops Tracker' },
            ].concat(opp.stage !== 'identified'
              ? [{ stage: opp.stage, at: opp.updatedAt || new Date(),
                   by: opp.owner || 'Tracker', note: 'Imported at current stage' }]
              : []),
          });
          oppsCreated++;
        }
      }

      res.json({
        ok: true, rows: parsed.records.length, skipped: parsed.skipped,
        contactsCreated, contactsUpdated, oppsCreated, oppsUpdated,
      });
    } catch (err) {
      console.error('POST /crm/import-tracker', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Opportunities ──────────────────────────────────────────────────────────

  router.get('/opportunities', async (req, res) => {
    try {
      const q = {};
      if (req.query.stage) q.stage = req.query.stage;
      if (req.query.division) q.division = req.query.division;
      if (req.query.open === 'true') q.stage = { $nin: ['won', 'lost'] };
      if (req.query.list) q.lists = req.query.list;
      // Archived deals stay out of the board by default — that is what the
      // programme's archive step is for — but remain fetchable for the reviews.
      if (req.query.archived === 'true') q.archived = true;
      else if (req.query.archived !== 'all') q.archived = { $ne: true };
      const now = Date.now();
      let opps = (await Opportunity.find(q).sort({ updatedAt: -1 }).lean()).map(o => decorateOpp(o, now));
      if (req.query.strategic === 'true') opps = opps.filter(o => o.strategic);
      if (req.query.needsReview === 'true') opps = opps.filter(o => o.needsReview);
      res.json(opps);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/opportunities', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name) return res.status(400).json({ error: 'Opportunity name required' });
      const stage = body.stage || 'identified';
      const opp = await Opportunity.create({
        ...body,
        stage,
        history: [{ stage, at: new Date(), by: req.user.displayName, note: 'Created' }],
        updatedAt: new Date(),
      });
      // Promoting a contact marks them converted so they leave the warm queue
      if (body.contactId) {
        await Contact.findByIdAndUpdate(body.contactId, {
          status: 'converted', funnelStage: 'qualified', updatedAt: new Date(),
        });
      }
      res.json(decorateOpp(opp));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/opportunities/:id', async (req, res) => {
    try {
      const body = { ...(req.body || {}) };
      delete body._id;
      delete body.history;
      const opp = await Opportunity.findById(req.params.id);
      if (!opp) return res.status(404).json({ error: 'Not found' });

      // Every stage move is appended to history — that array is the timeline
      if (body.stage && body.stage !== opp.stage) {
        opp.history.push({ stage: body.stage, at: new Date(), by: req.user.displayName, note: body.stageNote || '' });
        if (['won', 'lost'].includes(body.stage)) opp.closedAt = new Date();
        else opp.closedAt = null;
        // A won deal enters the delivery pipeline at intake unless told otherwise
        if (body.stage === 'won' && !opp.deliveryStage && !body.deliveryStage) opp.deliveryStage = 'tofu';
        // Reaching Proposal Out starts the follow-up ladder. Stamping it here
        // means nobody has to remember to fill in a date for the clock to run.
        if (body.stage === 'proposal' && !opp.proposalSentAt && !body.proposalSentAt) {
          opp.proposalSentAt = new Date();
          if (opp.proposalSent == null) opp.proposalSent = true;
        }
      }
      delete body.stageNote;
      // Choosing an escalation path is itself an event with a date — the review
      // wants to know when the ladder was answered, not only that it was.
      if (body.escalationPath && body.escalationPath !== opp.escalationPath) {
        opp.escalatedAt = new Date();
      } else if (body.escalationPath === '') {
        opp.escalatedAt = null;
      }
      if (body.archived === true && !opp.archivedAt) opp.archivedAt = new Date();
      if (body.archived === false) { opp.archivedAt = null; opp.archiveReason = ''; }
      Object.assign(opp, body, { updatedAt: new Date() });
      await opp.save();
      res.json(decorateOpp(opp));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/opportunities/:id', async (req, res) => {
    try {
      await Opportunity.findByIdAndDelete(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Funnel rollup ──────────────────────────────────────────────────────────
  // One payload the funnel view renders straight through:
  // top of funnel → opportunity tracker → deal flow timeline.

  router.get('/funnel', async (req, res) => {
    try {
      const now = Date.now();
      const contacts = (await Contact.find({}).lean()).map(c => decorate(c, now));
      // Archived deals are out of the pipeline by definition, so they are left
      // out of every band below and counted on their own in the SOP block.
      const allOpps = (await Opportunity.find({}).lean()).map(o => decorateOpp(o, now));
      const opps = allOpps.filter(o => !o.archived);

      const live = contacts.filter(c => c.status !== 'converted' && c.status !== 'do-not-contact');

      const tofu = FUNNEL_STAGES.map(stage => {
        const inStage = live.filter(c => c.funnelStage === stage.id);
        const warmth = {};
        WARMTH_TIERS.forEach(t => { warmth[t] = inStage.filter(c => c.warmth.tier === t).length; });
        return {
          ...stage,
          count: inStage.length,
          warmth,
          atRisk: inStage.filter(c => ['cold', 'dormant'].includes(c.warmth.tier)).length,
        };
      });

      // How work actually enters the funnel - the tracker's source column is
      // the honest top-of-funnel dimension, not a contact lifecycle guess.
      const bySource = {};
      opps.forEach(op => {
        const k = op.source || 'other';
        if (!bySource[k]) bySource[k] = { id: k, count: 0, value: 0, won: 0, lost: 0, open: 0 };
        bySource[k].count++;
        bySource[k].value += op.value || 0;
        if (op.stage === 'won') bySource[k].won++;
        else if (op.stage === 'lost') bySource[k].lost++;
        else bySource[k].open++;
      });
      const sources = Object.values(bySource)
        .map(s => ({ ...s, winRate: (s.won + s.lost) ? Math.round(s.won / (s.won + s.lost) * 100) : null }))
        .sort((a, b) => b.count - a.count);

      const tracker = OPP_STAGES.map(stage => {
        const inStage = opps.filter(o => o.stage === stage.id);
        const value = inStage.reduce((sum, o) => sum + (o.value || 0), 0);
        return {
          ...stage,
          count: inStage.length,
          value,
          weighted: Math.round(inStage.reduce((sum, o) => sum + (o.value || 0) * probabilityOf(o) / 100, 0)),
        };
      });

      // Deal flow timeline — won work placed on the delivery pipeline, which is
      // where the CRM hands off to the discovered process flows.
      const delivery = DELIVERY_STAGES.map(id => {
        const inStage = opps.filter(o => o.stage === 'won' && (o.deliveryStage || 'tofu') === id);
        return { id, count: inStage.length, value: inStage.reduce((s, o) => s + (o.value || 0), 0) };
      });

      // Median days spent in each opportunity stage, read off the history arrays
      const durations = {};
      OPP_STAGES.forEach(s => { durations[s.id] = []; });
      opps.forEach(o => {
        const h = (o.history || []).slice().sort((a, b) => new Date(a.at) - new Date(b.at));
        for (let i = 0; i < h.length; i++) {
          const end = h[i + 1]
            ? new Date(h[i + 1].at)
            : (['won', 'lost'].includes(o.stage) ? new Date(o.closedAt || now) : new Date(now));
          const days = Math.max(0, Math.round((end - new Date(h[i].at)) / DAY));
          if (durations[h[i].stage]) durations[h[i].stage].push(days);
        }
      });
      const stageDays = {};
      Object.entries(durations).forEach(([k, arr]) => {
        if (!arr.length) { stageDays[k] = null; return; }
        const sorted = arr.slice().sort((a, b) => a - b);
        stageDays[k] = sorted[Math.floor(sorted.length / 2)];
      });

      const open = opps.filter(o => !['won', 'lost'].includes(o.stage));
      const won = opps.filter(o => o.stage === 'won');
      const lost = opps.filter(o => o.stage === 'lost');
      // Contacts that ever reached qualified — converted ones are kept flagged there
      const everQualified = contacts.filter(c => c.funnelStage === 'qualified').length;
      const fromContacts = opps.filter(o => o.contactId).length;
      // One contact can carry several deals, so converting counts of deals into a
      // percentage of contacts gives nonsense like 104%. Count the people.
      const withOpp = new Set(opps.filter(o => o.contactId).map(o => String(o.contactId)));
      const contactsConverted = contacts.filter(c =>
        c.funnelStage === 'qualified' && withOpp.has(String(c._id))).length;

      // ── SOP compliance ────────────────────────────────────────────────────
      // What the two programmes say should be happening right now but is not.
      // Each number is a queue someone can work, which is why they are counts
      // of records rather than percentages.
      const openOpps = opps.filter(o => !['won', 'lost'].includes(o.stage));
      const slaLeads = live.filter(c => c.sla);
      const proposalRungs = { pending: 0, manager: 0, escalate: 0, overdue: 0 };
      let escalated = 0;
      openOpps.forEach(o => {
        if (!o.proposal) return;
        proposalRungs[o.proposal.phase]++;
        if (o.proposal.escalated) escalated++;
      });

      const byLeadSource = sop.LEAD_SOURCES.map(src => {
        const inSrc = live.filter(c => c.leadSource === src.id);
        return {
          id: src.id,
          label: src.label,
          count: inSrc.length,
          awaitingFirstContact: inSrc.filter(c => c.sla && ['due', 'late'].includes(c.sla.firstContact.state)).length,
          late: inSrc.filter(c => c.sla && c.sla.breaches.length).length,
        };
      });

      const retention = sop.CLIENT_TIERS.filter(t => t.cadence).map(t => {
        const inTier = live.filter(c => c.clientTier === t.id);
        return {
          id: t.id,
          label: t.label,
          rhythm: t.rhythm,
          cadence: t.cadence,
          count: inTier.length,
          due: inTier.filter(c => c.warmth.overdueDays > 0).length,
        };
      });

      const sopBlock = {
        leadSources: byLeadSource,
        retention,
        // Lead response clocks
        awaitingFirstContact: slaLeads.filter(c => c.sla.firstContact.state === 'due').length,
        firstContactLate: slaLeads.filter(c => c.sla.firstContact.state === 'late').length,
        followUpDue: slaLeads.filter(c => c.sla.followUp.state === 'late').length,
        loggedLate: slaLeads.filter(c => c.sla.logging.state === 'missed').length,
        slaTracked: slaLeads.length,
        // Simple Success Rule — owner, current status, next action
        successGaps: openOpps.filter(o => !o.successRule.ok).length,
        successMissing: sop.SUCCESS_FIELDS.map(f => ({
          id: f.id, label: f.label,
          count: openOpps.filter(o => o.successRule.missing.includes(f.id)).length,
        })),
        // Proposal follow-up ladder
        proposals: proposalRungs,
        proposalsPending: Object.values(proposalRungs).reduce((a, b) => a + b, 0),
        proposalsEscalated: escalated,
        proposalsNeedingStep: openOpps.filter(o => o.proposal && o.proposal.needsAttention).length,
        // Post-project check-in and archive housekeeping
        projectFollowUpDue: live.filter(c => c.projectFollowUp && c.projectFollowUp.state === 'due').length,
        projectFollowUpLate: live.filter(c => c.projectFollowUp && c.projectFollowUp.state === 'late').length,
        archiveDue: allOpps.filter(o => !o.archived && o.archive.due).length,
        archived: allOpps.filter(o => o.archived).length,
        // Strategic footprint
        strategicContacts: live.filter(c => c.strategic).length,
        strategicOpen: openOpps.filter(o => o.strategic).length,
        strategicValue: openOpps.filter(o => o.strategic).reduce((s, o) => s + (o.value || 0), 0),
      };

      res.json({
        tofu,
        sources,
        tracker,
        delivery,
        stageDays,
        sop: sopBlock,
        totals: {
          contacts: contacts.length,
          keepWarm: contacts.filter(c => ['keep-warm', 'nurture'].includes(c.status)).length,
          atRisk: live.filter(c => ['cold', 'dormant'].includes(c.warmth.tier)).length,
          // Coming due, not already overdue - those are counted in atRisk
          dueThisWeek: live.filter(c => c.warmth.overdueDays === 0 &&
            (c.warmth.cadence - c.warmth.daysSince) <= 7).length,
          openOpps: open.length,
          openValue: open.reduce((s, o) => s + (o.value || 0), 0),
          weightedValue: Math.round(open.reduce((s, o) => s + (o.value || 0) * probabilityOf(o) / 100, 0)),
          wonValue: won.reduce((s, o) => s + (o.value || 0), 0),
          winRate: (won.length + lost.length) ? Math.round(won.length / (won.length + lost.length) * 100) : null,
          // Top-of-funnel conversion: qualified contacts that became deals
          qualifiedToOpp: everQualified ? Math.round(contactsConverted / everQualified * 100) : null,
          everQualified,
          contactsConverted,
          oppsFromContacts: fromContacts,
        },
      });
    } catch (err) {
      console.error('GET /crm/funnel', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Source lists ───────────────────────────────────────────────────────────
  // The imported sheets stay addressable as the separate lists they are kept as.
  // This returns the registry plus live counts, so the Lists view can offer each
  // one on its own and say how much work is sitting in it.

  router.get('/lists', async (req, res) => {
    try {
      const now = Date.now();
      const contacts = (await Contact.find({}).lean()).map(c => decorate(c, now));
      const opps = (await Opportunity.find({ archived: { $ne: true } }).lean())
        .map(o => decorateOpp(o, now));

      // Lists a contact actually carries, including any this registry has not
      // been told about — a sheet imported later should still be reachable.
      const seen = new Set();
      contacts.forEach(c => (c.lists || []).forEach(k => seen.add(k)));
      const known = lists.LISTS.map(l => l.id);
      const extra = [...seen].filter(k => !known.includes(k)).sort();

      const describe = id => {
        const def = lists.listById(id);
        const members = contacts.filter(c => (c.lists || []).includes(id));
        const companies = new Set(members.map(c => (c.company || '').toLowerCase()).filter(Boolean));
        // A deal counts as belonging to a list if it was tagged with it or if it
        // is for a company on it — that second rule is what lets the merged view
        // show the tracker and the prospect sheets as one picture.
        const deals = opps.filter(o =>
          (o.lists || []).includes(id) ||
          (o.company && companies.has(o.company.toLowerCase())));
        const open = deals.filter(o => !['won', 'lost'].includes(o.stage));
        return {
          id,
          label: def ? def.label : lists.listLabel(id),
          group: def ? def.group : 'Imported',
          blurb: def ? def.blurb : '',
          file: def ? def.file : '',
          sheet: def ? def.sheet || null : null,
          subsetOf: def ? def.subsetOf || null : null,
          contacts: members.length,
          companies: companies.size,
          withEmail: members.filter(c => c.email).length,
          strategic: members.filter(c => c.strategic).length,
          atRisk: members.filter(c => ['cold', 'dormant'].includes(c.warmth.tier)).length,
          needsFirstContact: members.filter(c => c.sla && ['due', 'late'].includes(c.sla.firstContact.state)).length,
          deals: deals.length,
          openDeals: open.length,
          openValue: open.reduce((s, o) => s + (o.value || 0), 0),
          wonValue: deals.filter(o => o.stage === 'won').reduce((s, o) => s + (o.value || 0), 0),
        };
      };

      const unlisted = contacts.filter(c => !(c.lists || []).length);

      res.json({
        lists: [...known, ...extra].map(describe).filter(l => l.contacts > 0 || lists.listById(l.id)),
        // Everything that was in the CRM before Amy's sheets arrived. Shown as
        // its own row so "merged" is visibly the sum of named lists plus this.
        unlisted: {
          id: 'none',
          label: 'Not on an imported list',
          group: 'CRM',
          blurb: 'Contacts already in the CRM before the source lists were imported',
          contacts: unlisted.length,
          companies: new Set(unlisted.map(c => (c.company || '').toLowerCase()).filter(Boolean)).size,
          atRisk: unlisted.filter(c => ['cold', 'dormant'].includes(c.warmth.tier)).length,
        },
        totals: {
          contacts: contacts.length,
          listed: contacts.filter(c => (c.lists || []).length).length,
          deals: opps.length,
        },
      });
    } catch (err) {
      console.error('GET /crm/lists', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Reviews ────────────────────────────────────────────────────────────────
  // The two standing reports the opportunity programme calls for: the Monthly
  // Strategic Opportunity Review and the Quarterly Sales Performance Review.
  // Both are computed rather than compiled by hand, which is the only way they
  // get produced every month.

  router.get('/review', async (req, res) => {
    try {
      const now = Date.now();
      const all = (await Opportunity.find({}).lean()).map(o => decorateOpp(o, now));
      const contacts = (await Contact.find({}).lean()).map(c => decorate(c, now));
      const open = all.filter(o => !o.archived && !['won', 'lost'].includes(o.stage));

      // The review period. Defaults to the month and quarter we are in; the
      // page can ask for an earlier one when someone is writing up last month.
      const ref = parseDate(req.query.asOf) || new Date(now);
      const monthStart = new Date(ref.getFullYear(), ref.getMonth(), 1);
      const monthEnd = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
      const qIndex = Math.floor(ref.getMonth() / 3);
      const quarterStart = new Date(ref.getFullYear(), qIndex * 3, 1);
      const quarterEnd = new Date(ref.getFullYear(), qIndex * 3 + 3, 1);

      const inWindow = (d, from, to) => {
        if (!d) return false;
        const t = new Date(d).getTime();
        return t >= from.getTime() && t < to.getTime();
      };

      const strategicOpen = open.filter(o => o.strategic);

      // ── Monthly Strategic Opportunity Review ────────────────────────────────
      const monthly = {
        period: { start: monthStart, end: monthEnd,
          label: monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) },
        newStrategicLeads: all.filter(o => o.strategic && inWindow(o.openedAt, monthStart, monthEnd)).length,
        activeStrategicLeads: strategicOpen.length,
        strategicPipelineValue: strategicOpen.reduce((s, o) => s + (o.value || 0), 0),
        strategicWeightedValue: Math.round(
          strategicOpen.reduce((s, o) => s + (o.value || 0) * (o.probability || 0) / 100, 0)),
        proposalsSubmitted: all.filter(o =>
          inWindow(sop.proposalSentDate(o), monthStart, monthEnd)).length,
        wins: all.filter(o => o.stage === 'won' && inWindow(o.closedAt, monthStart, monthEnd)),
        losses: all.filter(o => o.stage === 'lost' && inWindow(o.closedAt, monthStart, monthEnd)),
        // Each strategic deal with what the review asks for: current status,
        // next action, estimated revenue, obstacles and support required. The
        // first two come straight from the tracker columns; the last two are
        // what the Simple Success Rule and the proposal ladder have flagged.
        review: strategicOpen
          .slice()
          .sort((a, b) => (b.value || 0) - (a.value || 0))
          .map(o => ({
            _id: o._id,
            name: o.name,
            company: o.company,
            owner: o.owner,
            stage: o.stage,
            value: o.value,
            probability: o.probability,
            expectedCloseAt: o.expectedCloseAt,
            status: o.statusUpdate,
            nextAction: o.nextAction,
            reasons: o.strategicReasons,
            obstacles: [
              ...o.successRule.labels.map(l => `Missing ${l.toLowerCase()}`),
              o.proposal && o.proposal.due ? o.proposal.due : null,
              o.archive.due && o.archive.reason === 'stale' ? 'No activity for 12 months' : null,
            ].filter(Boolean),
            supportRequired: o.proposal && o.proposal.escalated ? o.proposal.path.label : '',
          })),
        // Top 10 by value across the whole open pipeline, strategic or not.
        topTen: open.slice()
          .sort((a, b) => (b.value || 0) - (a.value || 0))
          .slice(0, 10)
          .map(o => ({
            _id: o._id, name: o.name, company: o.company, owner: o.owner,
            stage: o.stage, value: o.value, probability: o.probability,
            strategic: o.strategic, needsReview: o.needsReview,
            nextAction: o.nextAction,
          })),
      };

      // ── Quarterly Sales Performance Review ──────────────────────────────────
      // Segment rollup across the programme's target markets. Leads generated
      // counts contacts that entered in the quarter, which is the only honest
      // reading of "leads" — an opportunity is already past that point.
      const segmentIds = trackerSheet.SEGMENTS.map(s => s.code);
      const bySegment = segmentIds.map(code => {
        const def = trackerSheet.SEGMENTS.find(s => s.code === code);
        const segOpps = all.filter(o => o.segment === code);
        const inQuarter = segOpps.filter(o => inWindow(o.openedAt, quarterStart, quarterEnd));
        const won = segOpps.filter(o => o.stage === 'won' && inWindow(o.closedAt, quarterStart, quarterEnd));
        const lost = segOpps.filter(o => o.stage === 'lost' && inWindow(o.closedAt, quarterStart, quarterEnd));
        const segOpen = segOpps.filter(o => !o.archived && !['won', 'lost'].includes(o.stage));
        return {
          id: code,
          label: def ? def.label : code,
          // "Leads generated" means leads — contacts that entered on one of the
          // programme's four sources — dated by when we met them or logged
          // them. Counting every contact by createdAt would report a bulk
          // import of account history as a quarter of record lead generation.
          leads: contacts.filter(c => c.segment === code && c.leadSource &&
            inWindow(c.capturedAt || c.loggedAt || c.createdAt, quarterStart, quarterEnd)).length,
          activeOpportunities: segOpen.length,
          proposals: segOpps.filter(o => inWindow(sop.proposalSentDate(o), quarterStart, quarterEnd)).length,
          wins: won.length,
          losses: lost.length,
          estimatedRevenue: segOpen.reduce((s, o) => s + (o.value || 0), 0),
          revenueSecured: won.reduce((s, o) => s + (o.value || 0), 0),
          winRate: (won.length + lost.length)
            ? Math.round(won.length / (won.length + lost.length) * 100) : null,
          // "New Clients" is one of the report's own lines.
          newClients: new Set(won.filter(o => o.newTarget).map(o => o.company)).size,
        };
      }).filter(s => s.leads || s.activeOpportunities || s.proposals || s.wins || s.losses);

      const quarterly = {
        period: { start: quarterStart, end: quarterEnd,
          label: `Q${qIndex + 1} ${quarterStart.getFullYear()}` },
        bySegment,
        totals: bySegment.reduce((acc, s) => ({
          leads: acc.leads + s.leads,
          activeOpportunities: acc.activeOpportunities + s.activeOpportunities,
          proposals: acc.proposals + s.proposals,
          wins: acc.wins + s.wins,
          losses: acc.losses + s.losses,
          estimatedRevenue: acc.estimatedRevenue + s.estimatedRevenue,
          revenueSecured: acc.revenueSecured + s.revenueSecured,
          newClients: acc.newClients + s.newClients,
        }), { leads: 0, activeOpportunities: 0, proposals: 0, wins: 0, losses: 0,
              estimatedRevenue: 0, revenueSecured: 0, newClients: 0 }),
      };

      // ── Needs immediate review ──────────────────────────────────────────────
      // The Simple Success Rule's own consequence, as a worklist.
      const needsReview = open
        .filter(o => o.needsReview)
        .sort((a, b) => (b.value || 0) - (a.value || 0))
        .map(o => ({
          _id: o._id, name: o.name, company: o.company, owner: o.owner,
          stage: o.stage, value: o.value, strategic: o.strategic,
          missing: o.successRule.labels,
          proposal: o.proposal ? { days: o.proposal.days, phase: o.proposal.phase, due: o.proposal.due } : null,
        }));

      // Deals the archive rule says should be moved out of the tracker.
      const archiveDue = all
        .filter(o => !o.archived && o.archive.due)
        .map(o => ({
          _id: o._id, name: o.name, company: o.company, stage: o.stage,
          value: o.value, reason: o.archive.reason, idleDays: o.archive.idleDays || null,
        }));

      res.json({ monthly, quarterly, needsReview, archiveDue });
    } catch (err) {
      console.error('GET /crm/review', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Email drafting ─────────────────────────────────────────────────────────

  router.post('/draft', async (req, res) => {
    try {
      const { contactId, templateId } = req.body || {};
      const raw = await Contact.findById(contactId).lean();
      if (!raw) return res.status(404).json({ error: 'Contact not found' });
      const contact = decorate(raw);
      const opp = await Opportunity.findOne({
        contactId: String(raw._id), stage: { $nin: ['won', 'lost'] },
      }).lean();
      res.json(draftFor(contact, opp, templateId, req.user.displayName));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Campaigns ──────────────────────────────────────────────────────────────

  router.get('/campaigns', async (req, res) => {
    try {
      res.json(await Campaign.find({}).sort({ updatedAt: -1 }).lean());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/campaigns', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name) return res.status(400).json({ error: 'Campaign name required' });
      const campaign = await Campaign.create({ ...body, createdBy: req.user.displayName, updatedAt: new Date() });
      res.json(campaign);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/campaigns/:id', async (req, res) => {
    try {
      const body = { ...(req.body || {}), updatedAt: new Date() };
      delete body._id;
      const campaign = await Campaign.findByIdAndUpdate(req.params.id, body, { new: true });
      if (!campaign) return res.status(404).json({ error: 'Not found' });
      res.json(campaign);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/campaigns/:id', async (req, res) => {
    try {
      await Campaign.findByIdAndDelete(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Resolve the audience filter into real contacts, then render every step of
  // the series for each one — a reviewable send sheet, not an automated blast.
  router.post('/campaigns/:id/generate', async (req, res) => {
    try {
      const campaign = await Campaign.findById(req.params.id).lean();
      if (!campaign) return res.status(404).json({ error: 'Not found' });

      const a = campaign.audience || {};
      const q = {};
      if (a.funnelStages && a.funnelStages.length) q.funnelStage = { $in: a.funnelStages };
      if (a.divisions && a.divisions.length) q.divisions = { $in: a.divisions };
      if (a.offices && a.offices.length) q.office = { $in: a.offices };
      if (a.tags && a.tags.length) q.tags = { $in: a.tags };
      if (a.segments && a.segments.length) q.segment = { $in: a.segments };
      if (a.serviceAreas && a.serviceAreas.length) q.serviceAreas = { $in: a.serviceAreas };
      // do-not-contact is never targetable, whatever the audience says
      const statuses = (a.statuses || []).filter(s => s !== 'do-not-contact');
      q.status = statuses.length ? { $in: statuses } : { $ne: 'do-not-contact' };

      const now = Date.now();
      let contacts = (await Contact.find(q).lean()).map(c => decorate(c, now));
      if (a.warmth && a.warmth.length) contacts = contacts.filter(c => a.warmth.includes(c.warmth.tier));
      const noEmail = contacts.filter(c => !c.email).length;
      contacts = contacts.filter(c => c.email);

      const oppByContact = {};
      (await Opportunity.find({ stage: { $nin: ['won', 'lost'] } }).lean())
        .forEach(o => { if (o.contactId) oppByContact[o.contactId] = o; });

      const steps = (campaign.steps || []).slice().sort((x, y) => (x.dayOffset || 0) - (y.dayOffset || 0));

      const sends = contacts.map(c => {
        const opp = oppByContact[String(c._id)] || null;
        return {
          contactId: String(c._id),
          name: c.fullName,
          email: c.email,
          company: c.company,
          warmth: c.warmth.tier,
          daysSince: c.warmth.daysSince,
          lastTouchNote: c.lastTouchNote,
          emails: steps.length
            // Authored steps get their merge fields filled from what we know
            ? steps.map(s => ({
                dayOffset: s.dayOffset || 0,
                channel: s.channel || 'email',
                sendAt: new Date(now + (s.dayOffset || 0) * DAY),
                subject: merge(s.subject, c, opp, req.user.displayName),
                body: merge(s.body, c, opp, req.user.displayName),
                stopIf: s.stopIf || '',
              }))
            // No authored steps → fall back to the per-contact smart draft
            : [{
                dayOffset: 0,
                channel: 'email',
                sendAt: new Date(now),
                ...pick(draftFor(c, opp, null, req.user.displayName), ['subject', 'body', 'templateLabel', 'rationale']),
              }],
        };
      });

      res.json({ campaign: campaign.name, audienceSize: sends.length, noEmail, sends });
    } catch (err) {
      console.error('POST /crm/campaigns/:id/generate', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

module.exports.warmthFor = warmthFor;
module.exports.parseCsv = parseCsv;
module.exports.merge = merge;
module.exports.rowToContact = rowToContact;
module.exports.buildHeaderMap = buildHeaderMap;
module.exports.FUNNEL_STAGES = FUNNEL_STAGES;
module.exports.OPP_STAGES = OPP_STAGES;

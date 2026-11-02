// ── Opportunity Tracker import ───────────────────────────────────────────────
// Maps the live "Ops Tracker (Sales Handoff)" export onto the CRM. Each row in
// that sheet is really two records: the person we are talking to (a Contact we
// keep warm) and the deal itself (an Opportunity). This splits them and links
// them, so the tracker keeps working exactly as it does today while the warm
// list and the funnel fall out of it for free.
//
// The sheet is hand-maintained, so every column is normalized rather than
// trusted: service areas, sources, segments and outcomes all arrive in mixed
// case and mixed spelling, money arrives as free text, and there is no stage
// column at all — stage is derived from the proposal and win/lost columns.

// Header -> column, matched loosely so a re-ordered or renamed export still lands.
const TRACKER_COLUMNS = {
  date:         ['date', 'date added', 'created'],
  originator:   ['originator'],
  client:       ['client name', 'client'],
  contactName:  ['client contact name', 'contact name'],
  phone:        ['phone'],
  email:        ['contact', 'email'],
  description:  ['opportunity description', 'description'],
  opsManager:   ['iea ops manager', 'ops manager'],
  owner:        ['opportunity owner', 'owner'],
  lastUpdated:  ['last updated', 'last update'],
  statusUpdate: ['status update:  current status and next steps towards opportunity conversion',
                 'status update: current status and next steps towards opportunity conversion',
                 'status update', 'current status and next steps'],
  proposal:     ['proposal        (yes / no or #)', 'proposal (yes / no or #)', 'proposal'],
  value:        ['project value ($ guess)', 'project value'],
  outcome:      ['win / lost', 'win/lost', 'win lost'],
  source:       ['opportunity source', 'source'],
  referral:     ['referral / association name', 'referral name', 'association name'],
  serviceArea:  ['iea service area', 'service area'],
  estAmount:    ['est amount', 'estimated amount'],
  closeDate:    ['expected close date', 'close date'],
  segment:      ['segment'],
  csiUpdate:    ['csi client connect updates', 'csi client connect update', 'csi updates'],
};

// Service areas as the business writes them, collapsed to stable codes. The
// flow tool calls hazmat work EPDM; the sales sheet calls it Hazardous
// Materials — division maps that back so a deal can link to a discovered flow.
const SERVICE_AREAS = [
  { code: 'HAZMAT', label: 'Hazardous Materials', division: 'EPDM',
    match: /^(haz(ardous)?\s*(materials?|mat)?|asbestos|lead)$/i },
  { code: 'EHS',    label: 'EHS',                 division: 'EHS',  match: /^ehs$/i },
  { code: 'IAQ',    label: 'IAQ',                 division: 'IAQ',  match: /^iaq$/i },
  { code: 'IH',     label: 'Industrial Hygiene',  division: 'IAQ',  match: /^(ih|ih sampling|industrial hygiene)$/i },
  { code: 'ENG',    label: 'Engineering',         division: 'ENG',  match: /^(eng|engineering)$/i },
  { code: 'ENV',    label: 'Environmental',       division: 'EHS',  match: /^(env|environmental)$/i },
];

// Top-of-funnel channels. This column is how a deal entered the funnel, so it
// is the dimension the top-of-funnel view groups by.
const SOURCES = [
  { code: 'website',   label: 'Website',          match: /^(web\s*site|website|web)$/i },
  { code: 'referral',  label: 'Referral',         match: /^referral$/i },
  { code: 'existing',  label: 'Existing Client',  match: /^(existing|existing client|current client|existing ?)$/i },
  { code: 'rfp',       label: 'RFP',              match: /rfp/i },
  { code: 'tradeshow', label: 'Trade Show / Assoc', match: /(trade\s*show|masms|msba|mhcea|conference|safety council|lmc|assoc)/i },
  { code: 'outbound',  label: 'Outbound / Prospecting', match: /(leadium|call list|marketing|recapture|satterfield|nooks)/i },
  { code: 'partner',   label: 'Partner / Channel', match: /(insurance|wold|knutson|contegrity|inbylt|ra ?morton|sfm|mavo|recs|hennepin county contract)/i },
  { code: 'inbound',   label: 'Inbound (phone / email)', match: /^(phone|email|emailed|call)$/i },
];

const SEGMENTS = [
  { code: 'k12',        label: 'K-12',              match: /^k-?12$/i },
  { code: 'highered',   label: 'Higher Education',  match: /^(higher ?ed(ucation)?|college|university)$/i },
  { code: 'education',  label: 'Education (other)', match: /^((private )?education|church|school)$/i },
  { code: 'government', label: 'Government',        match: /^(gov(ernment|t)?|federal|state)$/i },
  { code: 'county',     label: 'County',            match: /^county$/i },
  { code: 'city',       label: 'City',              match: /^(city|municipal)$/i },
  { code: 'manufacturing', label: 'Manufacturing',  match: /^(manufacturing|manuf.*|industrial)$/i },
  { code: 'healthcare', label: 'Healthcare',        match: /^(health ?care|life ?sciences?|medical|biomedical)/i },
  { code: 'commercial', label: 'Commercial',        match: /^(commercial|property management|insurance|construction|litigation|retail)$/i },
  { code: 'cannabis',   label: 'Cannabis',          match: /^cannabis$/i },
];

function clean(v) {
  // The export is CP1252; stray replacement chars are placeholders, not data.
  return String(v == null ? '' : v).replace(/�/g, '').replace(/\s+/g, ' ').trim();
}

function norm(v) { return clean(v).toLowerCase(); }

function classify(value, table, fallback) {
  const v = clean(value);
  if (!v) return fallback;
  const hit = table.find(t => t.match.test(v));
  return hit ? hit.code : fallback;
}

// A service-area cell may hold several areas: "EHS/IH/Hazardous Materials".
function parseServiceAreas(value) {
  const parts = clean(value).split(/[\/,&+]|\band\b/i).map(s => s.trim()).filter(Boolean);
  const codes = [];
  parts.forEach(p => {
    const hit = SERVICE_AREAS.find(s => s.match.test(p));
    if (hit && !codes.includes(hit.code)) codes.push(hit.code);
  });
  return codes;
}

function divisionFor(codes) {
  for (const c of codes) {
    const hit = SERVICE_AREAS.find(s => s.code === c);
    if (hit) return hit.division;
  }
  return '';
}

// "WIN", "W", "Lift Inspection (win)" -> won. "NO" in this column means the
// deal was not won, not that the column is unanswered.
function parseOutcome(value) {
  const v = norm(value);
  if (!v || v === 'n/a' || v === 'na') return null;
  if (/\bwin\b|^w$/.test(v)) return 'won';
  if (/lost|loss|^l$|^no$/.test(v)) return 'lost';
  if (/^p$|pending/.test(v)) return 'pending';
  return null;
}

// "Yes", "YES", "y", "4950" (a proposal number) all mean a proposal went out.
function parseProposalSent(value) {
  const v = norm(value);
  if (!v) return null;
  if (/^(y|yes)$/.test(v)) return true;
  if (/^(n|no)$/.test(v)) return false;
  if (/^\d+$/.test(v)) return true;      // proposal number
  return null;                            // "ght", "Unknown" - unreadable
}

// Free-text money: "$58,000", "25000-35000", "220,000 (over 5 years)",
// "$16,800-28,000", "N/A", "working on price". Takes the first real number,
// which for a range is the conservative end.
function parseMoney(value) {
  const v = clean(value);
  if (!v || /^n\/?a$/i.test(v)) return 0;
  const m = v.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  if (!m) return 0;
  const n = Number(m[0]);
  return isFinite(n) ? Math.round(n) : 0;
}

// Dates arrive as M/D/YYYY plus a long tail of hand-typed variants:
// "6.30.2026", "10/23/2025 by 2:00 pm", "November 24, 2025 at 3:00pm", "?".
function parseDate(value) {
  const v = clean(value);
  if (!v || v === '?') return null;
  let m = v.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) {
    let [, mo, d, y] = m;
    y = Number(y); if (y < 100) y += 2000;
    const dt = new Date(y, Number(mo) - 1, Number(d));
    return isNaN(dt) ? null : dt;
  }
  const dt = new Date(v.replace(/\s+(by|at|noon).*$/i, ''));
  return isNaN(dt) ? null : dt;
}

// Hand-typed year typos put rows in the future; clamp rather than drop, so the
// row still imports but cannot masquerade as a recent touch.
function notFuture(d) {
  if (!d) return d;
  const now = new Date();
  return d.getTime() > now.getTime() ? now : d;
}

function splitName(full) {
  const v = clean(full).replace(/\(.*?\)/g, '').trim();
  if (!v || /^(unknown|unkown|rfp|n\/a|\?)$/i.test(v)) return { firstName: '', lastName: '' };
  // "Reyes, Marta" vs "Marta Reyes"; drop a trailing ", Title" fragment
  if (v.includes(',')) {
    const [a, b] = v.split(',');
    const tail = clean(b);
    // "Lori Severson, CSP" - a credential, not a surname
    if (/^(csp|chmm|cih|pe|p\.e\.|ph\.?d|business mgr.*|project manager|.*(manager|director|specialist|supervisor).*)$/i.test(tail)) {
      const parts = clean(a).split(/\s+/);
      return { firstName: parts.shift() || '', lastName: parts.join(' ') };
    }
    return { firstName: tail, lastName: clean(a) };
  }
  const parts = v.split(/\s+/);
  return { firstName: parts.shift() || '', lastName: parts.join(' ') };
}

function firstEmail(value) {
  const m = clean(value).match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m ? m[0].toLowerCase().replace(/[.,;]+$/, '') : '';
}

function firstPhone(value) {
  const m = clean(value).match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return m ? m[0].trim() : '';
}

// There is no stage column, so stage is inferred from the two columns that do
// record progress. Order matters: a recorded outcome always wins.
function deriveStage(outcome, proposalSent, statusUpdate, closeDate) {
  if (outcome === 'won') return 'won';
  if (outcome === 'lost') return 'lost';
  const text = norm(statusUpdate);
  // The sheet often records a death in prose without filling the outcome column
  if (/\b(this is dead|is dead|dead opportunity|did not submit|unable to bid|not submitting|went with (another|prior|current)|decided to (keep|complete)|declined our proposal|no longer able to provide)\b/.test(text))
    return 'lost';
  if (proposalSent === true) return 'proposal';
  if (outcome === 'pending') return 'proposal';
  if (closeDate) return 'qualifying';
  if (text) return 'qualifying';
  return 'identified';
}

// How often this relationship should be touched, given where the deal sits.
// Without this every imported row inherits the 14-day qualified cadence and a
// 2023 deal reads as "1089 days overdue", which is noise rather than signal.
const CADENCE_BY_STAGE = {
  proposal:   14,   // proposal out - chase it
  verbal:     14,
  qualifying: 30,
  identified: 45,
  won:        90,   // an active client, kept warm
  lost:      180,   // nurture - revisit next budget cycle
};


// The tracker's own "Last Updated" is the honest anchor.
function buildHeaderIndex(headerRow) {
  const idx = {};
  headerRow.forEach((raw, i) => {
    const h = norm(raw).replace(/\s+/g, ' ');
    for (const [field, aliases] of Object.entries(TRACKER_COLUMNS)) {
      if (idx[field] === undefined && aliases.includes(h)) { idx[field] = i; break; }
    }
  });
  return idx;
}

// Parse the tracker export into linked contact + opportunity pairs.
// `parseCsv` is injected so this module stays free of its own CSV parser.
function parseTracker(parseCsv, text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('Tracker export needs a header row and at least one data row');
  const idx = buildHeaderIndex(rows[0]);
  const required = ['client', 'statusUpdate', 'owner'];
  const missing = required.filter(f => idx[f] === undefined);
  if (missing.length)
    throw new Error('This does not look like the Opportunity Tracker export (missing: ' + missing.join(', ') + ')');

  const get = (row, field) => (idx[field] !== undefined ? clean(row[idx[field]]) : '');
  const out = [];
  let skipped = 0;

  rows.slice(1).forEach((row, i) => {
    const client = get(row, 'client');
    if (!client) { skipped++; return; }              // blank spacer rows

    const serviceAreas = parseServiceAreas(get(row, 'serviceArea'));
    const outcome      = parseOutcome(get(row, 'outcome'));
    const proposalSent = parseProposalSent(get(row, 'proposal'));
    const statusUpdate = get(row, 'statusUpdate');
    const csiUpdate    = get(row, 'csiUpdate');
    const closeDate    = parseDate(get(row, 'closeDate'));
    const opened       = notFuture(parseDate(get(row, 'date')));
    const updated      = notFuture(parseDate(get(row, 'lastUpdated'))) || opened;
    const stage        = deriveStage(outcome, proposalSent, statusUpdate, closeDate);
    const value        = parseMoney(get(row, 'value')) || parseMoney(get(row, 'estAmount'));
    const { firstName, lastName } = splitName(get(row, 'contactName'));
    const email        = firstEmail(get(row, 'email'));
    const owner        = get(row, 'owner') || get(row, 'opsManager');
    const description  = get(row, 'description') || 'Opportunity';

    // The newest thing anyone wrote about this relationship is what a rep needs
    // to see first, and what an email draft should reference.
    const lastNote = csiUpdate || statusUpdate;

    out.push({
      rowNumber: i + 2,
      contact: {
        externalId: 'tracker:' + norm(client) + '|' + norm(email || firstName + lastName),
        firstName, lastName,
        company: client,
        email,
        phone: firstPhone(get(row, 'phone')),
        owner,
        source: classify(get(row, 'source'), SOURCES, 'other'),
        segment: classify(get(row, 'segment'), SEGMENTS, ''),
        serviceAreas,
        divisions: divisionFor(serviceAreas) ? [divisionFor(serviceAreas)] : [],
        // Won work means a client we keep warm; a live deal is an active
        // relationship; everything else is nurture.
        status: stage === 'won' ? 'converted' : (stage === 'lost' ? 'keep-warm' : 'active'),
        funnelStage: stage === 'identified' ? 'aware' : 'qualified',
        cadenceDays: CADENCE_BY_STAGE[stage] || 60,
        lastTouchAt: updated,
        lastTouchType: csiUpdate ? 'note' : 'note',
        lastTouchNote: lastNote.slice(0, 600),
        notes: statusUpdate,
      },
      opportunity: {
        name: client + ' - ' + description,
        company: client,
        description,
        stage,
        value,
        probability: null,
        division: divisionFor(serviceAreas),
        serviceAreas,
        segment: classify(get(row, 'segment'), SEGMENTS, ''),
        owner,
        opsManager: get(row, 'opsManager'),
        originator: get(row, 'originator'),
        source: classify(get(row, 'source'), SOURCES, 'other'),
        sourceRaw: get(row, 'source'),
        referralName: get(row, 'referral'),
        proposalSent,
        statusUpdate,
        csiUpdate,
        expectedCloseAt: closeDate,
        openedAt: opened,
        updatedAt: updated,
        closedAt: (stage === 'won' || stage === 'lost') ? updated : null,
      },
    });
  });

  return { records: out, skipped };
}

module.exports = {
  parseTracker,
  SERVICE_AREAS,
  SOURCES,
  SEGMENTS,
  parseMoney,
  parseDate,
  parseOutcome,
  parseProposalSent,
  parseServiceAreas,
  deriveStage,
  splitName,
  classify,
};

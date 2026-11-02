// ── Source lists ─────────────────────────────────────────────────────────────
// Amy keeps her prospecting and client-contact work in separate workbooks, and
// that separation is meaningful: the SE MN manufacturing sheet is a cold target
// list being worked top-down, the master contact sheet is account history, and
// the event sheet is a follow-up queue with its own clock. Merging them into one
// undifferentiated contact table would throw that away.
//
// So a contact remembers which lists it came from (`lists` on the Contact), and
// this registry describes each list well enough for the UI to show it on its own
// — or merged with the opportunity tracker — without a second copy of the
// vocabulary living in the page.

const LISTS = [
  {
    id: 'se-mn-top100',
    label: 'SE MN Manufacturing — Top 100',
    group: 'Prospecting',
    blurb: 'Cold target list of manufacturing and industrial firms in south-east Minnesota',
    file: 'Possible Manufacturing and Industrial Clients SE MN.xlsx',
    sheet: 'Top 100',
    mapper: 'prospect',
    leadSource: 'strategic',
    clientTier: 'prospect',
    segment: 'manufacturing',
    office: 'Rochester',
  },
  {
    id: 'se-mn-top30',
    label: 'SE MN Manufacturing — Top 30',
    group: 'Prospecting',
    blurb: 'The Top 100 narrowed to the firms actually being worked, with outreach notes',
    file: 'Possible Manufacturing and Industrial Clients SE MN.xlsx',
    sheet: 'Top 30',
    mapper: 'prospect',
    leadSource: 'strategic',
    clientTier: 'prospect',
    segment: 'manufacturing',
    office: 'Rochester',
    // The Top 30 is a working subset of the Top 100, so a company on both keeps
    // both tags rather than the second import overwriting the first.
    subsetOf: 'se-mn-top100',
  },
  {
    id: 'client-master',
    label: 'Client Contacts — through 9.5.2025',
    group: 'Account history',
    blurb: 'Master client contact sheet with sector, office and the year last contacted',
    file: 'Manu Indust Thru 9.5.25.xlsx',
    sheet: 'Thru 9.5.2025',
    mapper: 'clientSheet',
    // Deliberately no lead source. These are existing accounts, not new leads,
    // and the lead programme's "contact within 5 business days" clock is not a
    // thing you can be late on for a client you served in 2023. They are
    // governed by the retention programme's tier cadence instead.
    leadSource: null,
    clientTier: null, // derived from how recently they were contacted
  },
  {
    id: 'client-2024',
    label: 'Client Contacts — through June 2024',
    group: 'Account history',
    blurb: 'The earlier master sheet, carrying Mary and Amy\'s per-account comments',
    file: 'Manu Indust Thru 9.5.25.xlsx',
    sheet: 'Thru June 2024',
    mapper: 'clientSheet',
    leadSource: null, // see above — account history, not leads
    clientTier: null,
  },
  {
    id: 'events-2026',
    label: '2026 Trade Show & Event Follow-Up',
    group: 'Events',
    blurb: 'People met at 2026 shows, conferences and chapter meetings, with their open follow-up actions',
    file: '2026-trade-show-event-followup.md',
    mapper: 'eventMarkdown',
    leadSource: 'networking',
    clientTier: 'prospect',
  },
];

function listById(id) {
  return LISTS.find(l => l.id === id) || null;
}

// A list key that arrived from somewhere this registry does not know about still
// deserves a readable name rather than a raw slug.
function listLabel(id) {
  const l = listById(id);
  if (l) return l.label;
  return String(id || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ── Shared cell handling ─────────────────────────────────────────────────────

function clean(v) {
  return String(v == null ? '' : v)
    .replace(/�/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// "(N/A)", "N.A (?)", "?", "-" all mean the cell is empty. Carrying them
// through would put "(N/A)" on screen as if it were a city.
function cellValue(v) {
  const s = clean(v);
  return /^(\(?\s*n\.?\/?\s*a\.?\s*\)?|\?|-+|none|tbd|unknown)$/i.test(s) ? '' : s;
}

// These sheets routinely hold a contact-page URL where an email belongs, and
// sometimes two addresses in one cell. Take the first real address; anything
// else is a link worth keeping as a note, not an email we can send to.
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function pickEmail(v) {
  const m = clean(v).match(EMAIL_RE);
  return m ? m[0].toLowerCase() : '';
}

// "(800) 345-0583", "507-451-9555 xt. 53682", "2189299175" — keep the first
// number and whatever extension follows it, drop the rest of the cell.
function pickPhone(v) {
  const s = clean(v);
  const m = s.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(\s*(x|ext|xt)\.?\s*\d+)?/i);
  return m ? m[0].trim() : '';
}

// "Doe, Jane" and "Jane Doe" both appear; so does "N/A (?)".
function splitPerson(v) {
  const s = clean(v);
  if (!s || /^n\.?\/?a\b/i.test(s) || s === '?') return { firstName: '', lastName: '' };
  if (s.includes(',')) {
    const [last, ...rest] = s.split(',');
    return { firstName: clean(rest.join(',')), lastName: clean(last) };
  }
  const parts = s.split(' ').filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

// The sheet writes offices in shorthand.
const OFFICE_ALIASES = [
  { office: 'Brooklyn Park',      match: /^(bp|brooklyn ?park|twin cities|metro)$/i },
  { office: 'Rochester',          match: /^roch(ester)?$/i },
  { office: 'Mankato',            match: /^mankato$/i },
  { office: 'Marshall',           match: /^marshall$/i },
  { office: 'Virginia & Brainerd', match: /^(virginia|brainerd|virginia ?& ?brainerd|v ?& ?b)$/i },
];

function officeFrom(v) {
  const s = clean(v);
  if (!s) return '';
  const hit = OFFICE_ALIASES.find(o => o.match.test(s));
  return hit ? hit.office : '';
}

// "Last Year Contacted" is a year, not a date. Treating it as 31 December would
// make every one of these contacts look freshly touched; treating it as 1
// January would make them all look a year colder than they are. Mid-year is the
// honest reading, and the record is flagged so the UI can say the date is an
// estimate rather than a logged touch.
function yearToDate(v) {
  const m = clean(v).match(/\b(19|20)\d{2}\b/);
  if (!m) return null;
  const year = Number(m[0]);
  if (year < 1990 || year > 2100) return null;
  return new Date(Date.UTC(year, 6, 1));
}

function parseDateCell(v) {
  const s = clean(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ── Mapper: prospect sheets (Top 100 / Top 30) ───────────────────────────────
// These rows are companies, not people. Most have no name at all — just a
// contact page, or an email that implies someone. The company is the record and
// the person fills in later, which is exactly how the list is being worked.

function mapProspectRow(row, list) {
  const company = clean(row['Business Name']);
  if (!company) return null;

  const emailCell = clean(row['Email/Contact Page']);
  const email = pickEmail(emailCell);
  const worked = clean(row['Have they worked with IEA before?']);
  const wasClient = /^y(es)?\b/i.test(worked);

  // The Top 30's notes record outreach as prose — "Sent initial email 9/8/2026".
  // That date is the first-contact clock the SOP wants, so read it rather than
  // treating a worked lead as one nobody has touched.
  const rowNotes = clean(row['Notes']);
  const sent = rowNotes.match(/\b(?:sent|emailed|e-?mailed)\b[^.]*?\b(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const firstContactAt = sent ? parseDateCell(sent[1]) : null;

  // A cell that held a link rather than an address is still useful — it is where
  // the next person goes to make contact.
  const contactPage = !email && /^https?:\/\//i.test(emailCell) ? emailCell : '';
  const website = clean(row['Website']);

  const notes = [
    clean(row['Type']) && `Type: ${clean(row['Type'])}`,
    rowNotes,
    contactPage && `Contact page: ${contactPage}`,
    website && !/^https?:\/\//i.test(website) ? '' : website && `Website: ${website}`,
    worked && `Worked with IEA before: ${worked}`,
  ].filter(Boolean).join('\n');

  return {
    company,
    email,
    phone: pickPhone(row['Phone #']),
    office: list.office || '',
    segment: list.segment || '',
    leadSource: list.leadSource,
    firstContactAt,
    funnelStage: firstContactAt ? 'aware' : 'unqualified',
    // A company IEA has worked with before is a dormant account to re-open, not
    // a cold prospect — the retention program treats those differently.
    clientTier: wasClient ? 'dormant' : 'prospect',
    newTarget: !wasClient,
    status: 'active',
    sites: clean(row['City']) ? [clean(row['City'])] : [],
    notes,
    tags: ['se-mn-manufacturing'],
  };
}

// ── Mapper: client contact sheets ────────────────────────────────────────────

function mapClientRow(row, list, classifySegment, now) {
  const company = clean(row['Client']);
  if (!company) return null;

  const person = splitPerson(row['Contact']);
  const lastYear = yearToDate(row['Last Year Contacted']);
  const thisYear = new Date(now || Date.now()).getUTCFullYear();
  const year = lastYear ? lastYear.getUTCFullYear() : null;

  // The retention program's own tiering: consistently used recently = Active,
  // gone quiet = Past/Dormant. Two years is the line where its language stops
  // calling someone a current client.
  let clientTier = 'dormant';
  if (year != null && year >= thisYear - 1) clientTier = 'active';

  const sector = clean(row['Sector']);
  const subsector = clean(row['Subsector']);
  const comments = [clean(row["Mary's comments"]), clean(row['Amy Comments']), clean(row['Notes?'])]
    .filter(Boolean);

  const city = cellValue(row['City']);
  const street = cellValue(row['Address']);
  const address = [street, [city, cellValue(row['State']), cellValue(row['ZIP Code'])]
    .filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const notes = [
    sector && `Sector: ${[sector, subsector].filter(Boolean).join(' / ')}`,
    address,
    year && `Last contacted (year only, from the sheet): ${year}`,
    ...comments,
  ].filter(Boolean).join('\n');

  return {
    externalId: cellValue(row['Client Number']) || undefined,
    firstName: person.firstName,
    lastName: person.lastName,
    title: cellValue(row['Title']),
    company,
    email: pickEmail(row['Email']),
    phone: pickPhone(row['Phone Number']),
    office: officeFrom(row['Office?']),
    segment: classifySegment(sector || subsector),
    leadSource: list.leadSource || '',
    clientTier,
    status: clientTier === 'dormant' ? 'nurture' : 'active',
    funnelStage: 'aware',
    lastTouchAt: lastYear,
    lastTouchEstimated: !!lastYear,
    lastTouchType: lastYear ? 'note' : '',
    lastTouchNote: year ? `Sheet records contact during ${year}; exact date unknown.` : '',
    sites: city ? [city] : [],
    notes,
  };
}

// ── Mapper: the event follow-up markdown ─────────────────────────────────────
// Amy's follow-up file is a nested checklist: an event heading, the people met
// there, and the open actions under each. All three levels matter — the event
// is when the lead was captured (which starts the SOP clock), the person is the
// contact, and the unticked boxes are the next actions.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

// "MASMS — Sept 30–Oct 2, 2026", "ASSP PDC — Feb 17", "April 2026". Take the
// first date named; for a range that is the day the event started.
function eventDate(heading, fallbackYear) {
  const text = String(heading || '');
  const ym = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})?\b[^,]*?,?\s*(\d{4})?/i);
  if (!ym) return null;
  const month = MONTHS.findIndex(m => m.startsWith(ym[1].toLowerCase()));
  if (month < 0) return null;
  const day = ym[2] ? Number(ym[2]) : 1;
  const year = ym[3] ? Number(ym[3]) : fallbackYear;
  if (!year) return null;
  return new Date(Date.UTC(year, month, Math.min(Math.max(day, 1), 28)));
}

function parseEventMarkdown(text, fallbackYear) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let event = null, evDate = null, current = null;

  const flush = () => {
    if (current && current.company !== undefined) out.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      flush();
      event = clean(h2[1]);
      evDate = eventDate(event, fallbackYear);
      continue;
    }

    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      flush();
      const title = clean(h3[1]).replace(/^[⭐*\s]+/, ''); // drop the ⭐ priority marker
      const starred = /[⭐]/.test(h3[1]);

      // "Name — Company", "Name / Name — Company, Title", or just a label like
      // "Marketing — ASHE Post Follow Up" which is a task, not a person.
      const parts = title.split(/\s+[—–-]\s+/);
      const who = clean(parts[0]);
      const rest = clean(parts.slice(1).join(' — '));
      // Not every heading is a person. Some are standing tasks ("Marketing —
      // ASHE Post Follow Up") and some are placeholders for a name Amy still
      // has to find ("Becker Schools Business Manager", "MHCEA Committee").
      // Importing those would create contacts nobody can ever email.
      const named = who.split('/')[0].trim();
      const ROLE_PLACEHOLDER = /\b(business manager|manager|contacts?|committee|staff|team|department|office)$/i;
      const isPerson = /^[A-Z][A-Za-z.'-]*(\s+[A-Z][A-Za-z.'-]*)*$/.test(named) &&
                       !/^(general|marketing)$/i.test(who) &&
                       !ROLE_PLACEHOLDER.test(named);
      if (!isPerson) { current = null; continue; }

      const person = splitPerson(who.split('/')[0]);
      // "Project Executive, Knutson Construction" — title first, company last.
      const bits = rest.split(',').map(clean).filter(Boolean);
      let company = bits.length ? bits[bits.length - 1] : '';
      const jobTitle = bits.length > 1 ? bits.slice(0, -1).join(', ') : '';
      // Some headings give an address where the employer would go —
      // "Jerusa Ricke — jerusafrederick@team-ind.com". That is a contact
      // detail, not a company name.
      const headingEmail = pickEmail(company);
      if (headingEmail) company = '';

      current = {
        ...person,
        title: jobTitle,
        company,
        emails: headingEmail ? [headingEmail] : [],
        event,
        eventAt: evDate,
        starred,
        actions: [],
        openActions: [],
        notes: '',
      };
      continue;
    }

    if (!current) continue;

    const item = line.match(/^\s*-\s*\[( |x|X)\]\s*(.*)$/);
    if (item) {
      const done = item[1].toLowerCase() === 'x';
      const body = clean(item[2]);
      current.actions.push({ done, text: body });
      if (!done) current.openActions.push(body);
      const mail = pickEmail(body);
      if (mail && !current.emails.includes(mail)) current.emails.push(mail);
      continue;
    }

    // Italic context lines under a name — "*Introduced by Lee Wendell with SFM*"
    const note = line.match(/^\s*\*(.+)\*\s*$/);
    if (note) current.notes = [current.notes, clean(note[1])].filter(Boolean).join('\n');
  }
  flush();

  return out;
}

// Turn one parsed event entry into a Contact. The open checkboxes become the
// next action, which is what the Simple Success Rule asks every lead to carry.
function mapEventEntry(entry, list) {
  if (!entry.firstName && !entry.lastName) return null;

  const notes = [
    entry.event && `Met at: ${entry.event}`,
    entry.notes,
    entry.actions.length && 'Follow-up actions:',
    ...entry.actions.map(a => `  ${a.done ? '[done]' : '[open]'} ${a.text}`),
  ].filter(Boolean).join('\n');

  return {
    firstName: entry.firstName,
    lastName: entry.lastName,
    title: entry.title,
    company: entry.company,
    email: entry.emails[0] || '',
    leadSource: list.leadSource,
    clientTier: list.clientTier,
    status: 'active',
    funnelStage: entry.actions.some(a => a.done) ? 'aware' : 'unqualified',
    // The event is when we met them, which is where the SOP's "logged within 2
    // business days" clock starts — not when this import happened to run.
    capturedAt: entry.eventAt,
    eventName: entry.event || '',
    nextAction: entry.openActions[0] || '',
    notes,
    tags: entry.starred ? ['priority', 'event-2026'] : ['event-2026'],
    newTarget: true,
  };
}

module.exports = {
  LISTS,
  listById,
  listLabel,
  mapProspectRow,
  mapClientRow,
  mapEventEntry,
  parseEventMarkdown,
  eventDate,
  pickEmail,
  pickPhone,
  splitPerson,
  officeFrom,
  yearToDate,
  parseDateCell,
  clean,
};

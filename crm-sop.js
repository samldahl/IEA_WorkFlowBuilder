// ── Sales SOP rules ──────────────────────────────────────────────────────────
// Amy's two written programs, expressed as code so the CRM enforces them rather
// than relying on anyone remembering them:
//
//   New Opportunity & Lead Program   — where leads come from, how fast we must
//                                      answer, what makes a lead Strategic, the
//                                      Simple Success Rule, the archive rule.
//   Client & Revenue Retention Program — how often we check in on a client by
//                                      tier, the post-project check-in, and the
//                                      proposal follow-up escalation ladder.
//
// Everything here is *derived*. None of it is a field someone has to keep up to
// date, because the whole point of the SOPs is that the clock runs whether or
// not anybody updates a spreadsheet.

const DAY = 86400000;
const HOUR = 3600000;

// ── Lead sources ─────────────────────────────────────────────────────────────
// The program says all leads originate from one of four sources, and each one
// carries its own response clock. The clocks are business days except the
// website one, which the program writes in hours ("within 24 hours") because an
// inbound request that sits over a weekend is already lost.

const LEAD_SOURCES = [
  {
    id: 'networking',
    label: 'Networking Event',
    blurb: 'Trade shows, conferences, association meetings, chamber events',
    logDays: 2,           // business days from meeting them to being in the tracker
    firstContactDays: 5,  // business days from logging to first outreach
    followUpDays: 14,     // calendar days before chasing a silent first email
    firstStep: 'Email to make the connection, suggest a meeting, connect on LinkedIn',
  },
  {
    id: 'existing',
    label: 'Existing Client',
    blurb: 'Cross-sell, new service requests, expansion projects, client referrals',
    logDays: 2,
    firstContactDays: 5,
    followUpDays: 14,
    firstStep: 'CSI assigns ownership, then contact the client or schedule follow-up',
  },
  {
    id: 'website',
    label: 'Website Inquiry',
    blurb: 'Contact Us forms and Request a Quote',
    logDays: 1,
    firstContactHours: 24, // the program's own wording — hours, not business days
    followUpDays: 14,
    firstStep: 'Designated CSI reviews, routes to a service or region, replies within 24 hours',
  },
  {
    id: 'strategic',
    label: 'Strategic Lead ID',
    blurb: 'Identified through annual strategic planning',
    logDays: 2,
    firstContactDays: 5,
    followUpDays: 14,
    firstStep: 'Owner makes contact and brings it to the monthly Strategic review',
  },
];

// ── Strategic criteria ───────────────────────────────────────────────────────
// A lead is Strategic if it meets one or more of these. Several can be inferred
// from the segment and service areas we already hold, which matters because the
// imported lists carry the segment but nobody has ever ticked a Strategic box.

const STRATEGIC_CRITERIA = [
  { id: 'revenue',       label: 'High potential revenue' },
  { id: 'new-target',    label: 'New target client' },
  { id: 'healthcare',    label: 'Healthcare organization',    segments: ['healthcare'] },
  { id: 'manufacturing', label: 'Manufacturing organization', segments: ['manufacturing'] },
  { id: 'government',    label: 'Government entity',          segments: ['government', 'city', 'county'] },
  { id: 'school',        label: 'School district',            segments: ['k12'] },
  { id: 'multi-service', label: 'Multi-service opportunity' },
  { id: 'executive',     label: 'Executive relationship opportunity' },
];

// Revenue threshold for the 'revenue' criterion. The tracker's values are
// guesses, so this is deliberately a round number rather than a precise one.
const HIGH_VALUE = 50000;

// Titles that mean we are talking to someone who can sign, not someone who has
// to go ask. Drives the 'executive' criterion off the title we already import.
const EXEC_TITLE = /\b(owner|president|ceo|coo|cfo|cio|chief|vp|vice president|director|principal|partner|superintendent|administrator|general manager)\b/i;

// Which criteria a record meets on its own evidence. Anything a person ticked
// by hand is kept and merged on top, so the inference never erases a judgement.
function strategicReasons(rec, manual) {
  const found = new Set(Array.isArray(manual) ? manual : []);
  const segment = String(rec.segment || '').toLowerCase();
  const areas = rec.serviceAreas || [];
  const title = String(rec.title || '');

  STRATEGIC_CRITERIA.forEach(c => {
    if (c.segments && c.segments.includes(segment)) found.add(c.id);
  });
  if (Number(rec.value || 0) >= HIGH_VALUE) found.add('revenue');
  if (areas.length > 1) found.add('multi-service');
  if (EXEC_TITLE.test(title)) found.add('executive');
  if (rec.newTarget) found.add('new-target');

  return STRATEGIC_CRITERIA.filter(c => found.has(c.id)).map(c => c.id);
}

function criterionLabel(id) {
  const c = STRATEGIC_CRITERIA.find(x => x.id === id);
  return c ? c.label : id;
}

// ── Client tiers ─────────────────────────────────────────────────────────────
// The retention program's check-in rhythm. These cadences are what the warmth
// calculation should run on for anyone who is already a client — a stage-based
// cadence is a top-of-funnel idea and says nothing useful about a client we have
// delivered for.
//
// Note the program explicitly excludes contracted clients with an assigned
// account manager, which is what the 'contracted' tier is for: no clock.

const CLIENT_TIERS = [
  { id: 'strategic',  label: 'Strategic',    cadence: 90,   rhythm: 'Quarterly',
    blurb: 'Growth opportunity across a facility, multiple facilities, or a national footprint' },
  { id: 'active',     label: 'Active',       cadence: 180,  rhythm: 'Semi-annual',
    blurb: 'Uses IEA consistently — stay positioned for service growth' },
  { id: 'dormant',    label: 'Past / Dormant', cadence: 90, rhythm: 'Quarterly',
    blurb: 'Strategic potential but limited or no contact for a period' },
  { id: 'prospect',   label: 'Prospect',     cadence: null, rhythm: 'Funnel stage cadence',
    blurb: 'Not a client yet — the top-of-funnel cadence applies' },
  { id: 'contracted', label: 'Contracted',   cadence: null, rhythm: 'Account managed',
    blurb: 'Ongoing contract with an assigned account manager — outside this program' },
];

function tierFor(id) {
  return CLIENT_TIERS.find(t => t.id === id) || null;
}

// Days within which a completed project must get its thank-you / quality check.
const PROJECT_FOLLOWUP_DAYS = 14;

// Best contact practice: email, then if nothing comes back inside this window,
// a voicemail and an immediate second email.
const NO_REPLY_DAYS = 7;

// ── Proposal follow-up ───────────────────────────────────────────────────────
// The escalation ladder for a proposal sitting in Pending.

const PROPOSAL_SLA = {
  managerInquiry: 14, // 2 weeks — manager asks whether follow-up has happened
  escalate: 21,       // week 3 — pick an escalation path
  overdue: 28,        // week 4 — a path should have been picked by now
};

const ESCALATION_PATHS = [
  { id: 'csi', label: 'Option A — CSI team follow-up',
    when: 'Client has gone unresponsive, more relationship outreach is needed, or the opportunity is high-value or strategic',
    action: 'Transfer follow-up to CSI for executive-level or alternative contact outreach' },
  { id: 'client-facing', label: 'Option B — Client-facing staff support',
    when: 'Client has operational, technical or service concerns, or wants scope, staffing or delivery clarified',
    action: 'Client-facing staff joins the follow-up call and addresses the concerns' },
];

// ── Archive ──────────────────────────────────────────────────────────────────

const ARCHIVE_AFTER_DAYS = 365; // "no activity for 12 months"

const ARCHIVE_REASONS = [
  { id: 'won',       label: 'Won' },
  { id: 'lost',      label: 'Lost' },
  { id: 'stale',     label: 'No activity for 12 months' },
  { id: 'not-viable', label: 'No longer viable' },
];

// ── Business-day arithmetic ──────────────────────────────────────────────────
// The program counts in business days, so a lead met on a Friday is not late on
// Monday morning. Holidays are not modelled — weekends carry nearly all of the
// difference and a holiday calendar would be one more thing to maintain.

function dayOnly(d) {
  const x = new Date(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate());
}

function businessDaysBetween(from, to) {
  if (!from || !to) return 0;
  const a = dayOnly(from), b = dayOnly(to);
  if (isNaN(a) || isNaN(b) || b <= a) return 0;
  let days = 0;
  const cur = new Date(a);
  while (cur < b) {
    cur.setDate(cur.getDate() + 1);
    const d = cur.getDay();
    if (d !== 0 && d !== 6) days++;
  }
  return days;
}

function addBusinessDays(from, n) {
  const cur = dayOnly(from);
  let left = n;
  while (left > 0) {
    cur.setDate(cur.getDate() + 1);
    const d = cur.getDay();
    if (d !== 0 && d !== 6) left--;
  }
  return cur;
}

// ── Lead response SLA ────────────────────────────────────────────────────────
// Two clocks per lead: how fast it got logged, and how fast someone made
// contact. Both are reported even once satisfied, because the monthly review
// looks at whether we are *keeping* to the program, not only at what is late
// right now.
//
// States: 'met' (done inside the window), 'missed' (done outside it),
// 'due' (not done, still inside), 'late' (not done, past it), 'na'.

function leadSla(contact, now) {
  now = now || Date.now();
  const src = LEAD_SOURCES.find(s => s.id === contact.leadSource);
  if (!src) return null;

  const captured = contact.capturedAt ? new Date(contact.capturedAt) : null;
  const logged = new Date(contact.loggedAt || contact.createdAt || now);
  // A logged touch is a first contact. Without this, anyone we have actually
  // spoken to still shows as "awaiting first contact" until someone
  // backfills a date, which would make the queue useless on day one.
  const first = contact.firstContactAt ? new Date(contact.firstContactAt)
    : (contact.lastTouchAt ? new Date(contact.lastTouchAt) : null);

  // Clock 1 — into the tracker. Only measurable if we know when we met them.
  let logging = { state: 'na', days: null, limit: src.logDays };
  if (captured) {
    const used = businessDaysBetween(captured, logged);
    logging = { state: used <= src.logDays ? 'met' : 'missed', days: used, limit: src.logDays };
  }

  // Clock 2 — first outreach. Website inquiries run on hours.
  let contactClock;
  if (src.firstContactHours) {
    const limit = src.firstContactHours;
    const used = Math.floor(((first ? first.getTime() : now) - logged.getTime()) / HOUR);
    contactClock = {
      state: first ? (used <= limit ? 'met' : 'missed') : (used <= limit ? 'due' : 'late'),
      hours: Math.max(0, used), limitHours: limit,
      dueAt: new Date(logged.getTime() + limit * HOUR),
    };
  } else {
    const limit = src.firstContactDays;
    const used = businessDaysBetween(logged, first || now);
    contactClock = {
      state: first ? (used <= limit ? 'met' : 'missed') : (used <= limit ? 'due' : 'late'),
      days: used, limitDays: limit,
      dueAt: addBusinessDays(logged, limit),
    };
  }

  // Clock 3 — the two-week chase on a first email that got no reply.
  let followUp = { state: 'na' };
  if (first && !contact.respondedAt) {
    const since = Math.floor((now - first.getTime()) / DAY);
    const chased = contact.lastTouchAt && new Date(contact.lastTouchAt) > first;
    followUp = {
      state: chased ? 'met' : (since >= src.followUpDays ? 'late' : 'due'),
      days: since, limitDays: src.followUpDays,
      dueAt: new Date(first.getTime() + src.followUpDays * DAY),
      // The retention program's wording: no reply in a week means voicemail
      // plus an immediate second email, not another email on its own.
      voicemailDue: !chased && since >= NO_REPLY_DAYS,
    };
  } else if (first && contact.respondedAt) {
    followUp = { state: 'met', replied: true };
  }

  const breaches = [];
  if (logging.state === 'missed') breaches.push('logged late');
  if (contactClock.state === 'late') breaches.push('no first contact');
  else if (contactClock.state === 'missed') breaches.push('first contact late');
  if (followUp.state === 'late') breaches.push('follow-up overdue');

  return {
    source: src.id,
    sourceLabel: src.label,
    logging,
    firstContact: contactClock,
    followUp,
    breaches,
    // What the Leads view sorts and colours on.
    ok: breaches.length === 0,
    actionable: contactClock.state === 'late' || contactClock.state === 'due' ||
                followUp.state === 'late' || followUp.state === 'due',
  };
}

// ── Simple Success Rule ──────────────────────────────────────────────────────
// "Every opportunity must have a Lead Owner, a Current Status and a Next Action
// Item. If any of these items are missing, the lead requires immediate review."

const SUCCESS_FIELDS = [
  { id: 'owner',      label: 'Lead owner',  field: 'owner' },
  { id: 'status',     label: 'Current status', field: 'statusUpdate' },
  { id: 'nextAction', label: 'Next action', field: 'nextAction' },
];

function successRule(opp) {
  // The rule governs the sales pipeline. A won or lost deal has no next action
  // by definition, and flagging those would bury the open ones that do need a
  // person in a list of deals that are already finished.
  const closed = ['won', 'lost'].includes(opp.stage) || opp.archived;
  const missing = closed ? [] : SUCCESS_FIELDS
    .filter(f => !String(opp[f.field] || '').trim())
    .map(f => f.id);
  return {
    ok: missing.length === 0,
    closed,
    missing,
    labels: missing.map(id => (SUCCESS_FIELDS.find(f => f.id === id) || {}).label || id),
  };
}

// ── Proposal watch ───────────────────────────────────────────────────────────
// A proposal is Pending once it has gone out and the deal has not closed. The
// age runs from when it was sent; when the tracker never recorded a send date,
// fall back to when the deal first reached the proposal stage.

function proposalSentDate(opp) {
  if (opp.proposalSentAt) return new Date(opp.proposalSentAt);
  const hit = (opp.history || []).find(h => h.stage === 'proposal');
  if (hit) return new Date(hit.at);
  return null;
}

function proposalWatch(opp, now) {
  now = now || Date.now();
  const closed = ['won', 'lost'].includes(opp.stage);
  if (closed || opp.proposalSent !== true) return null;

  const sent = proposalSentDate(opp);
  if (!sent || isNaN(sent)) return null;

  const days = Math.max(0, Math.floor((now - sent.getTime()) / DAY));
  let phase;
  if (days < PROPOSAL_SLA.managerInquiry) phase = 'pending';
  else if (days < PROPOSAL_SLA.escalate)  phase = 'manager';
  else if (days <= PROPOSAL_SLA.overdue)  phase = 'escalate';
  else phase = 'overdue';

  // Picking a path stops the ladder — the deal is being worked, not ignored.
  const escalated = !!opp.escalationPath;
  const path = ESCALATION_PATHS.find(p => p.id === opp.escalationPath) || null;

  return {
    sentAt: sent,
    days,
    phase,
    escalated,
    path,
    // The ladder step the program says should be happening now.
    due: escalated ? null
      : phase === 'manager'  ? 'Manager asks whether follow-up has happened and what came back'
      : phase === 'escalate' ? 'Pick an escalation path — CSI follow-up or client-facing support'
      : phase === 'overdue'  ? 'Past 28 days with no escalation path chosen'
      : null,
    needsAttention: !escalated && phase !== 'pending',
  };
}

// ── Archive ──────────────────────────────────────────────────────────────────

function archiveCheck(opp, now) {
  now = now || Date.now();
  if (opp.archived) return { archived: true, reason: opp.archiveReason || '' };
  if (opp.stage === 'won')  return { archived: false, due: true, reason: 'won' };
  if (opp.stage === 'lost') return { archived: false, due: true, reason: 'lost' };

  const last = opp.updatedAt || opp.openedAt;
  const idle = last ? Math.floor((now - new Date(last).getTime()) / DAY) : 0;
  if (idle >= ARCHIVE_AFTER_DAYS) {
    return { archived: false, due: true, reason: 'stale', idleDays: idle };
  }
  return { archived: false, due: false, idleDays: idle };
}

// ── Retention check-in ───────────────────────────────────────────────────────
// The cadence a client should be touched on, and whether a finished project is
// still owed its check-in.

function retentionCadence(contact) {
  const tier = tierFor(contact.clientTier);
  return tier && tier.cadence ? tier.cadence : null;
}

function projectFollowUp(contact, now) {
  now = now || Date.now();
  if (!contact.lastProjectAt) return null;
  const done = new Date(contact.lastProjectAt);
  if (isNaN(done)) return null;

  // Any touch logged after the project closed is the check-in.
  const touched = contact.lastTouchAt && new Date(contact.lastTouchAt) > done;
  const days = Math.floor((now - done.getTime()) / DAY);
  return {
    completedAt: done,
    days,
    dueAt: new Date(done.getTime() + PROJECT_FOLLOWUP_DAYS * DAY),
    state: touched ? 'done' : (days <= PROJECT_FOLLOWUP_DAYS ? 'due' : 'late'),
    limitDays: PROJECT_FOLLOWUP_DAYS,
  };
}

module.exports = {
  LEAD_SOURCES,
  STRATEGIC_CRITERIA,
  CLIENT_TIERS,
  PROPOSAL_SLA,
  ESCALATION_PATHS,
  ARCHIVE_REASONS,
  ARCHIVE_AFTER_DAYS,
  PROJECT_FOLLOWUP_DAYS,
  NO_REPLY_DAYS,
  HIGH_VALUE,
  SUCCESS_FIELDS,
  strategicReasons,
  criterionLabel,
  tierFor,
  businessDaysBetween,
  addBusinessDays,
  leadSla,
  successRule,
  proposalWatch,
  proposalSentDate,
  archiveCheck,
  retentionCadence,
  projectFollowUp,
};

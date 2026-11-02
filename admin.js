// ── Admin module ─────────────────────────────────────────────────────────────
// The /admin dashboard: who is editing what, and who is allowed in.
//
// Edit history lives in two places by design — Change holds flow edits field by
// field (the per-flow history drawer needs that granularity) and Activity holds
// everything else (CRM writes, account changes). Neither alone answers "who has
// been working in here lately", so this module normalizes both into one feed
// and aggregates across them.
//
// Mounted by server.js as: app.use('/admin', adminRouter({...}))

const express = require('express');
const { Activity } = require('./activity');

const DAY_MS = 24 * 60 * 60 * 1000;

// "Last 30 days" means today plus the 29 before it, counted from midnight, so
// the window holds exactly as many days as the chart draws columns for.
function windowStart(days) {
  const n = Number(days);
  if (!isFinite(n) || n <= 0) return null;          // null = all time
  const d = new Date(Date.now() - (n - 1) * DAY_MS);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Midnight n days back, on the same basis as the window above.
function daysBackMidnight(n) {
  const d = new Date(Date.now() - (n - 1) * DAY_MS);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayKey(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// A flow edit and a CRM write are different records; the feed treats them as
// one kind of thing so the dashboard can sort them together.
function changeToEntry(c) {
  const created = !c.oldValue && c.newValue;
  const removed = c.oldValue && !c.newValue;
  return {
    id:          String(c._id),
    area:        'flow',
    action:      c.field === 'flow' && created ? 'create' : created ? 'add' : removed ? 'remove' : 'update',
    entity:      'flow',
    label:       c.flowName,
    context:     c.div,
    field:       c.field === 'flow' ? '' : c.field,
    oldValue:    c.oldValue || '',
    newValue:    c.newValue || '',
    detail:      '',
    username:    c.username,
    displayName: c.displayName,
    at:          c.at,
    flowId:      c.flowId,
  };
}

function activityToEntry(a) {
  return {
    id:          String(a._id),
    area:        a.area || 'other',
    action:      a.action || 'update',
    entity:      a.entity || '',
    label:       a.label || '',
    context:     a.entity || '',
    field:       '',
    oldValue:    '',
    newValue:    '',
    detail:      a.detail || '',
    username:    a.username,
    displayName: a.displayName,
    at:          a.at,
    flowId:      null,
  };
}

module.exports = function adminRouter({ authMiddleware, requireAdmin, User, Change, roles, soleAdminUsername, soleAdminLock }) {
  const router = express.Router();
  router.use(authMiddleware, requireAdmin);

  // Pull both collections for a window, normalize, and sort newest first.
  async function mergedFeed({ days, username, area }) {
    const since = windowStart(days);
    const timeFilter = since ? { at: { $gte: since } } : {};

    const wantFlow  = !area || area === 'all' || area === 'flow';
    const wantOther = !area || area === 'all' || area !== 'flow';

    const changeQuery = { ...timeFilter };
    if (username && username !== 'all') changeQuery.username = username;

    const activityQuery = { ...timeFilter };
    if (username && username !== 'all') activityQuery.username = username;
    if (area && area !== 'all' && area !== 'flow') activityQuery.area = area;

    const [changes, activities] = await Promise.all([
      wantFlow  ? Change.find(changeQuery).sort({ at: -1 }).limit(4000).lean()     : [],
      wantOther ? Activity.find(activityQuery).sort({ at: -1 }).limit(4000).lean() : [],
    ]);

    return [...changes.map(changeToEntry), ...activities.map(activityToEntry)]
      .sort((a, b) => new Date(b.at) - new Date(a.at));
  }

  // ── Dashboard aggregates ───────────────────────────────────────────────────
  // One request backs the whole dashboard: the tiles, both charts and the
  // per-person table all read the same numbers, so they cannot disagree.
  router.get('/stats', async (req, res) => {
    try {
      const days = req.query.days === undefined ? 30 : req.query.days;
      const entries = await mergedFeed({ days, username: req.query.user, area: req.query.area });
      const users = await User.find({}, '-password').sort({ username: 1 }).lean();

      const byUser     = new Map();
      const byDay      = new Map();
      const byArea     = new Map();
      const byField    = new Map();
      const byDivision = new Map();
      const flowsTouched = new Set();

      // Seed every day in the window so a quiet day reads as a zero rather
      // than vanishing and compressing the time axis.
      const span = Number(days);
      if (isFinite(span) && span > 0) {
        for (let i = span - 1; i >= 0; i--) byDay.set(dayKey(new Date(Date.now() - i * DAY_MS)), 0);
      }

      entries.forEach(e => {
        const u = byUser.get(e.username) || {
          username: e.username, displayName: e.displayName || e.username,
          total: 0, flow: 0, crm: 0, account: 0, comment: 0, other: 0,
          lastAt: null, flows: new Set(), divisions: new Map(),
        };
        u.total++;
        if (u[e.area] !== undefined) u[e.area]++; else u.other++;
        if (!u.lastAt || new Date(e.at) > new Date(u.lastAt)) u.lastAt = e.at;
        if (e.flowId) u.flows.add(e.flowId);
        if (e.area === 'flow' && e.context) u.divisions.set(e.context, (u.divisions.get(e.context) || 0) + 1);
        byUser.set(e.username, u);

        const k = dayKey(e.at);
        byDay.set(k, (byDay.get(k) || 0) + 1);
        byArea.set(e.area, (byArea.get(e.area) || 0) + 1);
        if (e.field) byField.set(e.field, (byField.get(e.field) || 0) + 1);
        if (e.area === 'flow' && e.context) byDivision.set(e.context, (byDivision.get(e.context) || 0) + 1);
        if (e.flowId) flowsTouched.add(e.flowId);
      });

      const topDivision = (m) => {
        let best = '', n = 0;
        m.forEach((v, k) => { if (v > n) { n = v; best = k; } });
        return best;
      };

      // Everyone with an account appears, including the people who have made no
      // edits — a dashboard that only lists the active cannot show the inactive.
      const perUser = users.map(u => {
        const s = byUser.get(u.username);
        return {
          username: u.username, displayName: u.displayName, role: u.role,
          total: s ? s.total : 0,
          flow:  s ? s.flow  : 0, crm:     s ? s.crm     : 0,
          account: s ? s.account : 0, comment: s ? s.comment : 0,
          flowsTouched: s ? s.flows.size : 0,
          topDivision:  s ? topDivision(s.divisions) : '',
          lastAt: s ? s.lastAt : null,
          createdAt: u.createdAt,
        };
      });

      // A user may have been deleted since their edits were recorded; their
      // work still happened, so keep them in the table rather than dropping it.
      byUser.forEach((s, uname) => {
        if (perUser.some(p => p.username === uname)) return;
        perUser.push({
          username: uname, displayName: s.displayName, role: null,
          total: s.total, flow: s.flow, crm: s.crm, account: s.account, comment: s.comment,
          flowsTouched: s.flows.size, topDivision: topDivision(s.divisions),
          lastAt: s.lastAt, createdAt: null, deleted: true,
        });
      });

      perUser.sort((a, b) => b.total - a.total || a.displayName.localeCompare(b.displayName));

      const sortedPairs = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
      const sevenDaysAgo = daysBackMidnight(7);
      const last7 = entries.filter(e => new Date(e.at) >= sevenDaysAgo).length;

      res.json({
        windowDays: isFinite(Number(days)) && Number(days) > 0 ? Number(days) : null,
        since: windowStart(days),
        totals: {
          edits:        entries.length,
          last7,
          activeUsers:  byUser.size,
          accounts:     users.length,
          flowsTouched: flowsTouched.size,
          crmActions:   byArea.get('crm') || 0,
        },
        perUser,
        perDay:      [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count })),
        perArea:     sortedPairs(byArea).map(([area, count]) => ({ area, count })),
        perField:    sortedPairs(byField).slice(0, 10).map(([field, count]) => ({ field, count })),
        perDivision: sortedPairs(byDivision).map(([div, count]) => ({ div, count })),
      });
    } catch (err) {
      console.error('GET /admin/stats error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Activity feed ──────────────────────────────────────────────────────────
  router.get('/activity', async (req, res) => {
    try {
      const limit  = Math.min(Number(req.query.limit) || 100, 500);
      const offset = Number(req.query.offset) || 0;
      const q = (req.query.q || '').trim().toLowerCase();

      let entries = await mergedFeed({
        days:     req.query.days === undefined ? 30 : req.query.days,
        username: req.query.user,
        area:     req.query.area,
      });

      if (q) {
        entries = entries.filter(e =>
          [e.label, e.displayName, e.username, e.field, e.detail, e.oldValue, e.newValue, e.context]
            .some(v => v && String(v).toLowerCase().includes(q)));
      }

      res.json({ total: entries.length, offset, items: entries.slice(offset, offset + limit) });
    } catch (err) {
      console.error('GET /admin/activity error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // How access is currently configured, so the People tab can explain itself
  // instead of silently refusing to promote anyone.
  router.get('/access', (req, res) => {
    res.json({ soleAdminUsername, soleAdminLock, roles: roles || [] });
  });

  return router;
};

module.exports.windowStart = windowStart;
module.exports.dayKey = dayKey;

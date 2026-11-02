// ── Activity log ─────────────────────────────────────────────────────────────
// The Change collection records flow edits field by field, which is the right
// shape for the per-flow history drawer but blind to everything else anyone
// does in here. This records the rest — CRM writes, account administration —
// in one flat shape so the admin dashboard can show a single honest feed of
// who did what, rather than a feed that silently stops at the CRM boundary.

const mongoose = require('mongoose');

const Activity = mongoose.model('Activity', new mongoose.Schema({
  // Broad bucket the dashboard filters and groups by.
  area:        { type: String, index: true },   // 'crm' | 'account' | 'flow' | 'comment'
  action:      String,                          // 'create' | 'update' | 'delete' | 'import' | ...
  entity:      String,                          // 'contact' | 'opportunity' | 'user' | ...
  entityId:    String,
  label:       String,                          // human name of the thing touched
  detail:      String,                          // one-line description of the change
  username:    { type: String, index: true },
  displayName: String,
  at:          { type: Date, default: Date.now, index: true },
}));

// Logging is observational — a failed write here must never fail the request
// that was being observed, so every call is fire-and-forget.
function logActivity(fields) {
  Activity.create({ at: new Date(), ...fields })
    .catch(err => console.error('Activity log error:', err.message));
}

// Pulls the actor off an authenticated request.
function actor(req) {
  return {
    username:    req.user ? req.user.username : 'unknown',
    displayName: req.user ? req.user.displayName : 'Unknown',
  };
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Router-level recorder. Hooks res.json so only requests that actually
// succeeded get logged, and so routes added later are covered without each one
// having to remember to log. `describe(req, body)` returns the record's
// descriptive fields, or null to skip the request entirely.
function recordWrites(area, describe) {
  return function (req, res, next) {
    if (!WRITE_METHODS.has(req.method)) return next();
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400) {
        try {
          const desc = describe(req, body);
          if (desc) logActivity({ area, ...desc, ...actor(req) });
        } catch (err) {
          console.error('Activity describe error:', err.message);
        }
      }
      return json(body);
    };
    next();
  };
}

module.exports = { Activity, logActivity, actor, recordWrites };

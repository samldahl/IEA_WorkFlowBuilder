require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { marked } = require('marked');
const puppeteer = require('puppeteer');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// External output — only used when PROJECTS_DIR env var is set (local dev only)
const PROJECTS_DIR = process.env.PROJECTS_DIR || null;

// Local output — always used; ephemeral on Heroku but fine for markdown generation
const LOCAL_OUT_DIR = path.join(__dirname, 'output', 'projects');

// PDF output
const PDF_OUT_DIR = path.join(__dirname, 'PDFOutput');

const IMAGES_DIR_LOCAL = path.join(LOCAL_OUT_DIR, 'masterOrgFlow', 'images');
const IMAGES_DIR_UPLOADS = path.join(__dirname, 'uploads');

// IMAGES_DIR is the primary serve path — prefer external if available, otherwise uploads
const IMAGES_DIR = PROJECTS_DIR
  ? path.join(PROJECTS_DIR, 'masterOrgFlow', 'images')
  : IMAGES_DIR_UPLOADS;

[IMAGES_DIR_LOCAL, IMAGES_DIR_UPLOADS, PDF_OUT_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
if (PROJECTS_DIR) {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

// MongoDB setup
const AppData = mongoose.model('AppData', new mongoose.Schema({ payload: mongoose.Schema.Types.Mixed }));

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/probeapp')
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, IMAGES_DIR_UPLOADS),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

function outputPaths(baseDir) {
  return {
    master: path.join(baseDir, 'masterOrgFlow', 'flows.md'),
    divisions: {
      EPDM:  path.join(baseDir, 'EPDM_Flow',    'EPDM_flow.md'),
      EHS:   path.join(baseDir, 'EHS_Flow',     'EHS_flow.md'),
      IAQ:   path.join(baseDir, 'IAQ_Flow',     'IAQ_flow.md'),
      ENG:   path.join(baseDir, 'ENG_Flow',     'ENG_flow.md'),
      ADMIN: path.join(baseDir, 'AdminOpsFlow', 'AdminOps_flow.md'),
    },
  };
}

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(IMAGES_DIR_UPLOADS));

// GET /data
app.get('/data', async (req, res) => {
  try {
    const doc = await AppData.findOne({});
    res.json(doc ? doc.payload : {});
  } catch (err) {
    console.error('GET /data error:', err);
    res.json({});
  }
});

const DIV_LABELS = { EPDM: 'EPDM', EHS: 'EHS', IAQ: 'IAQ', ENG: 'Engineering', ADMIN: 'Admin Operations' };

// POST /save — write to MongoDB, markdown output, and PDFs
app.post('/save', async (req, res) => {
  const data = req.body || {};
  const DIVISIONS = ['EPDM', 'EHS', 'IAQ', 'ENG', 'ADMIN'];
  try {
    await AppData.findOneAndUpdate({}, { payload: data }, { upsert: true, new: true });

    const baseDirs = [LOCAL_OUT_DIR];
    if (PROJECTS_DIR) baseDirs.push(PROJECTS_DIR);

    baseDirs.forEach(baseDir => {
      const out = outputPaths(baseDir);
      writeFile(out.master, generateMarkdown(data, 'images'));
      DIVISIONS.forEach(div => {
        if (!(Array.isArray(data[div]) && data[div].length)) return;
        writeFile(out.divisions[div], generateDivisionMarkdown(data, div, '../masterOrgFlow/images'));
      });
    });

    res.json({ ok: true });

    // PDF generation is async — runs after response is sent
    (async () => {
      const masterMd = generateMarkdown(data, IMAGES_DIR_UPLOADS);
      await writePdf(masterMd, 'IEA Discovered Flows', path.join(PDF_OUT_DIR, 'IEA_All_Flows.pdf'));
      for (const div of DIVISIONS) {
        if (!(Array.isArray(data[div]) && data[div].length)) continue;
        const divMd = generateDivisionMarkdown(data, div, IMAGES_DIR_UPLOADS);
        await writePdf(divMd, `${DIV_LABELS[div]} — Discovered Flows`, path.join(PDF_OUT_DIR, `${div}_flow.pdf`));
      }
    })().catch(err => console.error('PDF batch error:', err));

  } catch (err) {
    console.error('POST /save error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function mdToHtml(markdown, title) {
  const body = marked(markdown);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 11pt;
    line-height: 1.6;
    color: #1f2430;
    background: #fff;
    padding: 48px 56px;
    max-width: 900px;
    margin: 0 auto;
  }
  h1 { font-size: 22pt; font-weight: 700; color: #1f2430; margin-bottom: 6px; padding-bottom: 10px; border-bottom: 3px solid #e3e5e8; }
  h2 { font-size: 15pt; font-weight: 700; color: #1f2430; margin-top: 32px; margin-bottom: 10px; padding-bottom: 5px; border-bottom: 2px solid #e3e5e8; }
  h3 { font-size: 12pt; font-weight: 600; color: #4b5563; margin-top: 20px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.4px; }
  h4 { font-size: 12pt; font-weight: 600; color: #1f2430; margin-top: 18px; margin-bottom: 6px; }
  h5 { font-size: 11pt; font-weight: 600; color: #374151; margin-top: 14px; margin-bottom: 5px; }
  h6 { font-size: 10.5pt; font-weight: 600; color: #6b7280; margin-top: 12px; margin-bottom: 4px; }
  .subflow-block {
    margin-left: 20px;
    padding: 10px 14px 4px 14px;
    border-left: 3px solid #e3e5e8;
    background: #fafbfc;
    border-radius: 0 5px 5px 0;
    margin-bottom: 8px;
  }
  .subflow-block .subflow-block {
    margin-left: 16px;
    border-left-color: #d1d5db;
    background: #f4f5f7;
  }
  p { margin-bottom: 8px; }
  em { color: #6b7280; font-style: italic; font-size: 10pt; }
  strong { font-weight: 600; }
  code {
    background: #f0f1f3;
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 9.5pt;
    font-family: 'Courier New', monospace;
    color: #374151;
  }
  ul, ol { padding-left: 20px; margin-bottom: 8px; }
  li { margin-bottom: 3px; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0 16px;
    font-size: 9.5pt;
  }
  th {
    background: #f4f5f7;
    font-weight: 600;
    text-align: left;
    padding: 7px 10px;
    border: 1px solid #e3e5e8;
    white-space: nowrap;
  }
  td {
    padding: 6px 10px;
    border: 1px solid #e3e5e8;
    vertical-align: top;
  }
  tr:nth-child(even) td { background: #fafafa; }
  hr { border: none; border-top: 1px solid #e3e5e8; margin: 20px 0; }
  img { max-width: 100%; border-radius: 4px; margin: 6px 0; }
  a { color: #2563eb; text-decoration: none; }
</style>
</head>
<body>${body}</body>
</html>`;
}

let pdfBrowser = null;
async function getPdfBrowser() {
  if (!pdfBrowser || !pdfBrowser.connected) {
    pdfBrowser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return pdfBrowser;
}

async function writePdf(mdContent, title, outputPath) {
  try {
    const html = mdToHtml(mdContent, title);
    const browser = await getPdfBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: outputPath,
      format: 'Letter',
      margin: { top: '0.6in', bottom: '0.6in', left: '0.6in', right: '0.6in' },
      printBackground: true,
    });
    await page.close();
  } catch (err) {
    console.error('PDF generation failed for', outputPath, err.message);
  }
}

function writeFile(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

// ── helpers ────────────────────────────────────────────────────────────────

const PRIORITY_ORDER = { p0: 0, p1: 1, p2: 2, '': 3 };
const PRIORITY_LABEL = { p0: 'P0 — Critical', p1: 'P1 — Important', p2: 'P2 — Nice to Have', '': 'Unranked' };

function sortByPriority(flows) {
  return [...flows].sort((a, b) =>
    (PRIORITY_ORDER[a.priority || ''] ?? 3) - (PRIORITY_ORDER[b.priority || ''] ?? 3)
  );
}

function escapeCell(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const VIDEO_EXTS = /\.(mp4|mov|webm|avi|ogg)$/i;

function mdAttachmentLine(lines, a, imageRelPath, indent = '') {
  if (a.type === 'link') {
    lines.push(`${indent}- 🔗 [${escapeCell(a.label || a.url)}](${escapeCell(a.url)})`);
  } else {
    const relPath = `${imageRelPath}/${escapeCell(a.filename)}`;
    if (IMAGE_EXTS.test(a.filename)) {
      lines.push(`${indent}- ![${escapeCell(a.filename)}](${relPath})`);
    } else if (VIDEO_EXTS.test(a.filename)) {
      lines.push(`${indent}- 🎬 [${escapeCell(a.filename)}](${relPath})`);
    } else {
      lines.push(`${indent}- 📎 [${escapeCell(a.filename)}](${relPath})`);
    }
  }
}

function buildFlowLookup(data, divisions) {
  const lookup = {};
  divisions.forEach(div => {
    (data[div] || []).forEach(f => { lookup[f.id] = { name: f.name, div }; });
  });
  return lookup;
}

function renderFlowBlock(lines, f, flowLookup, imageRelPath, data, DIVISIONS, OFFICES, headingLevel = 4) {
  const hashes = '#'.repeat(Math.min(headingLevel, 6));
  const priLabel = f.priority ? ` \`${f.priority.toUpperCase()}\`` : '';
  lines.push(`${hashes} ${f.name || '(unnamed flow)'}${priLabel}`);
  lines.push('');

  if (f.trigger) lines.push(`**Trigger:** ${f.trigger}`);

  const setOwners = OFFICES.filter(o => f.owners && f.owners[o]);
  if (setOwners.length) lines.push(`**Owners:** ${setOwners.map(o => `${o}: ${f.owners[o]}`).join(' · ')}`);

  if (Array.isArray(f.triggeredBy) && f.triggeredBy.length) {
    const refs = f.triggeredBy.map(id => {
      const ref = flowLookup[id];
      return ref ? `${ref.div} › ${ref.name}` : id;
    }).join(', ');
    lines.push(`**Triggered by:** ${refs}`);
  }

  if (f.parentId && flowLookup[f.parentId]) {
    const p = flowLookup[f.parentId];
    lines.push(`**Part of:** ${p.div} › ${p.name}`);
  }

  const children = [];
  DIVISIONS.forEach(d => {
    (data[d] || []).forEach(child => { if (child.parentId === f.id) children.push(`${d} › ${child.name}`); });
  });
  if (children.length) lines.push(`**Sub-flows:** ${children.join(', ')}`);

  const uniqueTools = Array.from(new Set(
    (f.steps || []).map(s => (s.tool || '').trim()).filter(Boolean)
  ));
  if (uniqueTools.length) lines.push(`**Tools:** ${uniqueTools.join(', ')}`);

  if (f.endState) lines.push(`**End state:** ${f.endState}`);

  if (f.handoff && f.handoff.active && f.handoff.toDiv) {
    const cond = f.handoff.condition ? ` — _${f.handoff.condition}_` : '';
    lines.push(`**Hands off to:** ${f.handoff.toDiv}${cond}`);
  }

  lines.push('');

  const steps = Array.isArray(f.steps) ? f.steps.filter(s => s.who || s.what || s.tool) : [];
  if (steps.length) {
    lines.push('**Steps**');
    lines.push('');
    steps.forEach((s, i) => {
      const who  = s.who  ? `**${s.who}**` : '_[who?]_';
      const what = s.what ? s.what         : '_[what?]_';
      const tool = s.tool ? ` _(${s.tool})_` : '';
      lines.push(`${i + 1}. ${who} — ${what}${tool}`);
      (s.attachments || []).forEach(a => mdAttachmentLine(lines, a, imageRelPath, '   '));
    });
    lines.push('');
  }

  const flowAtts = Array.isArray(f.attachments) ? f.attachments.filter(a => a.url) : [];
  if (flowAtts.length) {
    lines.push('**Attachments**');
    flowAtts.forEach(a => mdAttachmentLine(lines, a, imageRelPath));
    lines.push('');
  }

  if (f.edgeCases) { lines.push(`**Edge cases:** ${f.edgeCases}`); lines.push(''); }
  if (f.notes)     { lines.push(`**Notes:** ${f.notes}`);           lines.push(''); }
}

function appendDivisionSection(lines, data, div, flowLookup, imageRelPath) {
  const DIVISIONS = ['EPDM', 'EHS', 'IAQ', 'ENG', 'ADMIN'];
  const OFFICES   = ['Brooklyn Park', 'Rochester', 'Mankato', 'Virginia & Brainerd', 'Marshall'];
  const allFlows  = Array.isArray(data[div]) ? data[div] : [];
  if (!allFlows.length) return;

  lines.push(`## ${div}`);
  lines.push('');

  const byId = {};
  allFlows.forEach(f => { byId[f.id] = f; });

  const topLevel = sortByPriority(allFlows.filter(f => !f.parentId || !byId[f.parentId]));

  const tiers = [
    { key: 'p0', flows: topLevel.filter(f => f.priority === 'p0') },
    { key: 'p1', flows: topLevel.filter(f => f.priority === 'p1') },
    { key: 'p2', flows: topLevel.filter(f => f.priority === 'p2') },
    { key: '',   flows: topLevel.filter(f => !f.priority)         },
  ].filter(t => t.flows.length);

  function renderWithChildren(f, depth) {
    const level = Math.min(depth + 4, 6);
    if (depth > 0) { lines.push('<div class="subflow-block">'); lines.push(''); }
    renderFlowBlock(lines, f, flowLookup, imageRelPath, data, DIVISIONS, OFFICES, level);
    sortByPriority(allFlows.filter(c => c.parentId === f.id))
      .forEach(child => renderWithChildren(child, depth + 1));
    if (depth > 0) { lines.push('</div>'); lines.push(''); }
  }

  tiers.forEach(tier => {
    if (tiers.length > 1) { lines.push(`### ${PRIORITY_LABEL[tier.key]}`); lines.push(''); }
    tier.flows.forEach(f => {
      renderWithChildren(f, 0);
      lines.push('---');
      lines.push('');
    });
  });
}

// ── Generators ──────────────────────────────────────────────────────────────

function generateMarkdown(data, imageRelPath = 'images') {
  const DIVISIONS = ['EPDM', 'EHS', 'IAQ', 'ENG', 'ADMIN'];
  const flowLookup = buildFlowLookup(data, DIVISIONS);
  const lines = [];
  const generated = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  lines.push('# IEA Discovered Flows');
  lines.push('');
  lines.push(`_Generated ${generated}_`);
  lines.push('');

  const allById = {};
  DIVISIONS.forEach(div => {
    (Array.isArray(data[div]) ? data[div] : []).forEach(f => { allById[f.id] = { f, div }; });
  });

  const topLevelAll = [];
  DIVISIONS.forEach(div => {
    (Array.isArray(data[div]) ? data[div] : [])
      .filter(f => !f.parentId || !allById[f.parentId])
      .forEach(f => topLevelAll.push({ ...f, _div: div }));
  });
  topLevelAll.sort((a, b) => (PRIORITY_ORDER[a.priority || ''] ?? 3) - (PRIORITY_ORDER[b.priority || ''] ?? 3));

  lines.push('## Summary');
  lines.push('');
  lines.push('| Pri | Flow | Division | Trigger | Tools | Hands Off To | End State |');
  lines.push('| --- | ---- | -------- | ------- | ----- | ------------ | --------- |');

  function summaryRow(f, div, depth) {
    const indent   = depth > 0 ? '↳ ' : '';
    const tools    = Array.from(new Set((f.steps || []).map(s => (s.tool || '').trim()).filter(Boolean))).join(', ');
    const handsOff = f.handoff && f.handoff.active && f.handoff.toDiv ? f.handoff.toDiv : '—';
    const pri      = f.priority ? `**${f.priority.toUpperCase()}**` : '—';
    lines.push(`| ${escapeCell(pri)} | ${indent}${escapeCell(f.name)} | ${escapeCell(div)} | ${escapeCell(f.trigger)} | ${escapeCell(tools)} | ${escapeCell(handsOff)} | ${escapeCell(f.endState)} |`);
    const children = [];
    DIVISIONS.forEach(childDiv => {
      (Array.isArray(data[childDiv]) ? data[childDiv] : [])
        .filter(c => c.parentId === f.id)
        .forEach(c => children.push({ c, childDiv }));
    });
    sortByPriority(children.map(x => x.c)).forEach(c => {
      const entry = children.find(x => x.c.id === c.id);
      summaryRow(c, entry.childDiv, depth + 1);
    });
  }

  topLevelAll.forEach(f => summaryRow(f, f._div, 0));

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Detail');
  lines.push('');

  DIVISIONS.forEach(div => appendDivisionSection(lines, data, div, flowLookup, imageRelPath));

  return lines.join('\n');
}

function generateDivisionMarkdown(data, div, imageRelPath = '../masterOrgFlow/images') {
  const DIVISIONS = ['EPDM', 'EHS', 'IAQ', 'ENG', 'ADMIN'];
  const flowLookup = buildFlowLookup(data, DIVISIONS);
  const divLabel = { EPDM: 'EPDM', EHS: 'EHS', IAQ: 'IAQ', ENG: 'Engineering', ADMIN: 'Admin Operations' };
  const generated = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const lines = [];

  lines.push(`# ${divLabel[div] || div} — Discovered Flows`);
  lines.push('');
  lines.push(`_Generated ${generated}_`);
  lines.push('');

  const allDivFlows = Array.isArray(data[div]) ? data[div] : [];
  const divById = {};
  allDivFlows.forEach(f => { divById[f.id] = f; });
  const divTopLevel = sortByPriority(allDivFlows.filter(f => !f.parentId || !divById[f.parentId]));

  lines.push('## Summary');
  lines.push('');
  lines.push('| Pri | Flow | Trigger | Tools | Hands Off To | End State |');
  lines.push('| --- | ---- | ------- | ----- | ------------ | --------- |');

  function divSummaryRow(f, depth) {
    const indent   = depth > 0 ? '↳ ' : '';
    const tools    = Array.from(new Set((f.steps || []).map(s => (s.tool || '').trim()).filter(Boolean))).join(', ');
    const handsOff = f.handoff && f.handoff.active && f.handoff.toDiv ? f.handoff.toDiv : '—';
    const pri      = f.priority ? `**${f.priority.toUpperCase()}**` : '—';
    lines.push(`| ${escapeCell(pri)} | ${indent}${escapeCell(f.name)} | ${escapeCell(f.trigger)} | ${escapeCell(tools)} | ${escapeCell(handsOff)} | ${escapeCell(f.endState)} |`);
    sortByPriority(allDivFlows.filter(c => c.parentId === f.id))
      .forEach(c => divSummaryRow(c, depth + 1));
  }

  divTopLevel.forEach(f => divSummaryRow(f, 0));

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Detail');
  lines.push('');

  appendDivisionSection(lines, data, div, flowLookup, imageRelPath);

  return lines.join('\n');
}

// POST /upload
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const src = req.file.path;
  [IMAGES_DIR_LOCAL].forEach(dest => {
    try { fs.copyFileSync(src, path.join(dest, req.file.filename)); } catch (e) { console.error('Copy to', dest, 'failed:', e.message); }
  });
  if (PROJECTS_DIR) {
    try { fs.copyFileSync(src, path.join(IMAGES_DIR, req.file.filename)); } catch (e) { console.error('Copy to PROJECTS_DIR failed:', e.message); }
  }
  res.json({ filename: req.file.filename, url: `/images/${req.file.filename}` });
});

// DELETE /upload/:filename
app.delete('/upload/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filesToDelete = [
    path.join(IMAGES_DIR_UPLOADS, filename),
    path.join(IMAGES_DIR_LOCAL, filename),
  ];
  if (PROJECTS_DIR) filesToDelete.push(path.join(IMAGES_DIR, filename));
  filesToDelete.forEach(fp => {
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (err) { /* ignore */ }
  });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`ProbeApp running at http://localhost:${PORT}`);
});

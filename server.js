'use strict';
/*
 * Aculife-IB Portal – server
 * Node.js + Express + PostgreSQL. Region access is enforced here, on the server.
 *
 * Environment variables:
 *   DATABASE_URL     PostgreSQL connection string (required in production)
 *   ADMIN_LOGIN      Login ID of the first super-admin (default: ADMIN)
 *   ADMIN_PASSWORD   Password of the first super-admin (used only on first start)
 *   PORT             Port to listen on (set automatically by most hosts)
 *   NODE_ENV         "production" on the host
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const sanitizeHtml = require('sanitize-html');

const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 7;

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */
let pool;
async function connectPg() {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  const tries = process.env.PGSSL === 'off' ? [false] : process.env.PGSSL === 'on' ? [{ rejectUnauthorized: false }] : [{ rejectUnauthorized: false }, false];
  let last;
  for (const ssl of tries) {
    const p = new Pool({ connectionString: url, ssl, max: 5 });
    try { await p.query('SELECT 1'); console.log('Database connected' + (ssl ? ' (SSL)' : '')); return p; }
    catch (e) { last = e; await p.end().catch(() => {}); }
  }
  throw last;
}
if (process.env.DATABASE_URL) {
  pool = null; // connected at startup
} else {
  if (PROD) { console.error('DATABASE_URL is not set. Refusing to start in production without a database.'); process.exit(1); }
  console.warn('\n*** No DATABASE_URL: using a temporary in-memory database (data is lost on restart). For testing only. ***\n');
  const { newDb } = require('pg-mem');
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();
}
const q = (text, params) => pool.query(text, params);

async function migrate() {
  await q(`CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY, login_id TEXT UNIQUE NOT NULL, name TEXT, role TEXT NOT NULL,
    region TEXT, password_hash TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`);
  await q(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value JSONB NOT NULL)`);
  await q(`CREATE TABLE IF NOT EXISTS notes(
    id SERIAL PRIMARY KEY, region TEXT NOT NULL, status TEXT NOT NULL, data JSONB NOT NULL,
    created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS priority(
    id SERIAL PRIMARY KEY, region TEXT NOT NULL, data JSONB NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS prio_tasks(
    id SERIAL PRIMARY KEY, partner_id INTEGER NOT NULL, region TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
    data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS note_files(
    id SERIAL PRIMARY KEY, note_id INTEGER NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
    data BYTEA NOT NULL, uploaded_by TEXT, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

// Turn an old one-row-per-partner priority row (task/status in the row) into a partner + task line.
async function upgradePriority() {
  const rows = (await q('SELECT * FROM priority')).rows;
  for (const r of rows) {
    const d = parse(r.data);
    if (d.task === undefined && d.status === undefined) continue;
    const ups = [];
    if (d.prevStatus) ups.push({ on: d.prevOn || '2026-09-15', at: d.prevOn ? d.prevOn + 'T12:00:00.000Z' : '2026-09-15T12:00:00.000Z', text: d.prevStatus, by: d.updatedBy || 'Imported' });
    if (d.status) ups.push({ on: d.statusOn || '2026-10-29', at: d.statusOn ? d.statusOn + 'T12:00:00.000Z' : '2026-10-29T12:00:00.000Z', text: d.status, by: d.updatedBy || 'Imported' });
    const t = { task: d.task || 'General follow-up', tcd: /^\d{4}-\d{2}-\d{2}$/.test(d.tcd || '') ? d.tcd : '', tcdHistory: [], updates: ups, status: 'Open', createdAt: new Date().toISOString(), createdBy: 'Imported', updatedAt: ups.length ? ups[ups.length - 1].at : new Date().toISOString(), updatedBy: d.updatedBy || 'Imported' };
    const has = (await q('SELECT COUNT(*)::int AS n FROM prio_tasks WHERE partner_id=$1', [r.id])).rows[0].n;
    if (!has) await q('INSERT INTO prio_tasks(partner_id,region,sort,data) VALUES($1,$2,1,$3)', [r.id, r.region, JSON.stringify(t)]);
    const p = { country: d.country, priority: d.priority, type: d.type, partner: d.partner, value: d.value || '', createdAt: d.createdAt || new Date().toISOString(), createdBy: d.createdBy || 'Imported' };
    await q('UPDATE priority SET data=$1 WHERE id=$2', [JSON.stringify(p), r.id]);
  }
}

const newPassword = () => {
  const up = 'ABCDEFGHJKLMNPQRSTUVWXYZ', dg = '23456789', lo = 'abcdefghjkmnpqrstuvwxyz';
  const pick = (s, n) => Array.from(crypto.randomBytes(n), b => s[b % s.length]).join('');
  return pick(up, 4) + pick(dg, 4) + '@' + pick(lo, 2);
};

async function seed() {
  const u = await q('SELECT COUNT(*)::int AS n FROM users');
  if (u.rows[0].n === 0) {
    const login = (process.env.ADMIN_LOGIN || 'ADMIN').toUpperCase();
    let pw = process.env.ADMIN_PASSWORD;
    if (!pw) { pw = newPassword(); console.log(`\n*** First super-admin created. Login ID: ${login}  Password: ${pw}  (change it after signing in) ***\n`); }
    await q('INSERT INTO users(login_id,name,role,region,password_hash) VALUES($1,$2,$3,$4,$5)',
      [login, 'Super Admin', 'super', '', bcrypt.hashSync(pw, 11)]);
    console.log(`Super-admin "${login}" created.`);
  }
  const s = await q("SELECT key FROM settings WHERE key='regions'");
  if (!s.rows.length) {
    const reg = findSeed('regions.json') || { regions: [], countries: {}, classes: {} };
    await q("INSERT INTO settings(key,value) VALUES('regions',$1)", [JSON.stringify(reg)]);
    console.log('Region master loaded:', reg.regions.length, 'regions,', Object.keys(reg.countries).length, 'countries.');
  }
  const p = await q('SELECT COUNT(*)::int AS n FROM priority');
  const flag = await q("SELECT key FROM settings WHERE key='priority_seeded'");
  if (p.rows[0].n === 0 && !flag.rows.length) {
    const rows = findSeed('priority.json') || [];
    let i = 0;
    for (const r of rows) { i++; await q('INSERT INTO priority(region,data,sort) VALUES($1,$2,$3)', [r.region, JSON.stringify(r), i]); }
    await q("INSERT INTO settings(key,value) VALUES('priority_seeded','true')");
    console.log('Priority sheet loaded:', rows.length, 'rows.');
  }
  await upgradePriority();
}

async function getSettings() {
  const r = await q("SELECT value FROM settings WHERE key='regions'");
  const v = r.rows[0] ? r.rows[0].value : { regions: [], countries: {}, classes: {} };
  return typeof v === 'string' ? JSON.parse(v) : v;
}
const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);

// Find a seed file wherever it was uploaded (seed/, Seed/, top level, or one folder deeper).
const fs = require('fs');
function findSeed(name) {
  const tried = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
    for (const e of entries) if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return path.join(dir, e.name);
    if (depth >= 3) return null;
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const hit = walk(path.join(dir, e.name), depth + 1); if (hit) return hit;
    }
    return null;
  };
  const found = walk(__dirname, 0);
  if (!found) { console.error(`Seed file ${name} not found anywhere in ${__dirname}. Upload the seed folder to GitHub.`); return null; }
  console.log(`Using ${path.relative(__dirname, found)}`);
  tried.push(found);
  return JSON.parse(fs.readFileSync(found, 'utf8'));
}

/* ------------------------------------------------------------------ */
/* App & security                                                      */
/* ------------------------------------------------------------------ */
const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      'script-src-attr': ["'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'connect-src': ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());

// Mutating API calls must come from our own page (custom header + same-site cookie).
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'aculife-ib') return res.status(403).json({ error: 'Forbidden' });
  next();
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' } });

const COOKIE = 'aib_sess';
async function auth(req, res, next) {
  const tok = req.cookies[COOKIE];
  if (!tok) return res.status(401).json({ error: 'Please sign in' });
  const r = await q(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at>NOW()`, [hash(tok)]);
  const u = r.rows[0];
  if (!u || !u.active) return res.status(401).json({ error: 'Please sign in' });
  req.user = u;
  next();
}
const hash = t => crypto.createHash('sha256').update(t).digest('hex');
const isAdmin = u => u.role === 'admin' || u.role === 'super';
const isSuper = u => u.role === 'super';
async function regionsFor(u) { return isAdmin(u) ? (await getSettings()).regions : [u.region]; }
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max = 2000) => String(v == null ? '' : v).slice(0, max).trim();

const RICH = {
  allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
    'h1', 'h2', 'h3', 'h4', 'div', 'span', 'img', 'a', 'sub', 'sup', 'hr'],
  allowedAttributes: { td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], img: ['src'], a: ['href', 'target', 'rel'] },
  allowedSchemes: ['http', 'https'],
  allowedSchemesByTag: { img: ['data'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) },
  exclusiveFilter: f => f.tag === 'img' && !/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(f.attribs.src || '')
};
const rich = h => sanitizeHtml(String(h || ''), RICH).slice(0, 1500000);

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */
app.post('/api/login', loginLimiter, wrap(async (req, res) => {
  const login = str(req.body.loginId, 60).toUpperCase(), pw = String(req.body.password || '');
  const r = await q('SELECT * FROM users WHERE login_id=$1', [login]);
  const u = r.rows[0];
  const ok = u && bcrypt.compareSync(pw, u.password_hash);
  if (!ok) return bad(res, 'Wrong Login ID or password.', 401);
  if (!u.active) return bad(res, 'This Login ID is disabled. Contact the IB admin.', 403);
  const tok = crypto.randomBytes(32).toString('hex');
  await q("DELETE FROM sessions WHERE expires_at<NOW()");
  await q(`INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,NOW() + INTERVAL '${SESSION_DAYS} days')`, [hash(tok), u.id]);
  res.cookie(COOKIE, tok, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: SESSION_DAYS * 864e5 });
  res.json({ ok: true });
}));
app.post('/api/logout', wrap(async (req, res) => {
  const tok = req.cookies[COOKIE];
  if (tok) await q('DELETE FROM sessions WHERE token=$1', [hash(tok)]);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
}));
app.get('/api/me', auth, wrap(async (req, res) => {
  const u = req.user;
  res.json({ loginId: u.login_id, name: u.name, role: u.role, region: u.region, regions: await regionsFor(u) });
}));
app.post('/api/me/password', auth, wrap(async (req, res) => {
  const cur = String(req.body.current || ''), nw = String(req.body.next || '');
  if (!bcrypt.compareSync(cur, req.user.password_hash)) return bad(res, 'Current password is wrong.');
  if (nw.length < 8) return bad(res, 'New password must be at least 8 characters.');
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(nw, 11), req.user.id]);
  await q('DELETE FROM sessions WHERE user_id=$1 AND token<>$2', [req.user.id, hash(req.cookies[COOKIE])]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Settings (regions & countries)                                      */
/* ------------------------------------------------------------------ */
app.get('/api/settings', auth, wrap(async (req, res) => res.json(await getSettings())));
app.put('/api/settings', auth, wrap(async (req, res) => {
  if (!isSuper(req.user)) return bad(res, 'Only the super-admin can change regions.', 403);
  const b = req.body || {};
  const regions = (Array.isArray(b.regions) ? b.regions : []).map(x => str(x, 80)).filter(Boolean);
  const countries = {}, classes = {};
  for (const [c, r] of Object.entries(b.countries || {})) { const k = str(c, 80); if (k && regions.includes(r)) countries[k] = r; }
  for (const [c, v] of Object.entries(b.classes || {})) { const k = str(c, 80); if (countries[k]) classes[k] = str(v, 4); }
  await q("UPDATE settings SET value=$1 WHERE key='regions'", [JSON.stringify({ regions, countries, classes })]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Approval notes                                                      */
/* ------------------------------------------------------------------ */
const NOTE_TEXT = ['subject', 'no', 'date', 'territory', 'preparedBy', 'department', 'claimValue', 'reviewer1', 'reviewer2', 'approver'];
const NOTE_RICH = ['objective', 'background', 'proposal'];
const noteOut = (r, files) => ({ ...parse(r.data), id: String(r.id), region: r.region, status: r.status, createdBy: r.created_by, files: files || [] });

async function nextNoteNo() {
  const y = new Date().getFullYear();
  const r = await q('SELECT data FROM notes');
  let max = 0;
  for (const row of r.rows) { const no = String(parse(row.data).no || ''); const m = /(\d+)$/.exec(no); if (m && no.includes(String(y))) max = Math.max(max, +m[1]); }
  return `AN/IB/${y}/${String(max + 1).padStart(3, '0')}`;
}

app.get('/api/notes', auth, wrap(async (req, res) => {
  const regs = await regionsFor(req.user);
  const r = await q('SELECT * FROM notes ORDER BY created_at DESC');
  const fs = (await q('SELECT id,note_id,filename,mime,size,uploaded_by,uploaded_at FROM note_files ORDER BY id')).rows;
  const by = {};
  for (const f of fs) (by[f.note_id] = by[f.note_id] || []).push({ id: String(f.id), filename: f.filename, mime: f.mime, size: f.size, by: f.uploaded_by, at: f.uploaded_at });
  res.json(r.rows.filter(x => regs.includes(x.region)).map(x => noteOut(x, by[x.id])));
}));

async function loadNote(req, res) {
  const r = await q('SELECT * FROM notes WHERE id=$1', [parseInt(req.params.id, 10) || 0]);
  const n = r.rows[0];
  if (!n || !(await regionsFor(req.user)).includes(n.region)) { bad(res, 'Note not found', 404); return null; }
  return n;
}
function cleanNote(body) {
  const o = {};
  for (const k of NOTE_TEXT) o[k] = str(body[k], k === 'subject' ? 300 : 200);
  for (const k of NOTE_RICH) o[k] = rich(body[k]);
  return o;
}

app.post('/api/notes', auth, wrap(async (req, res) => {
  const o = cleanNote(req.body || {});
  const settings = await getSettings();
  const region = settings.countries[o.territory];
  if (!o.subject) return bad(res, 'Subject is required');
  if (!region) return bad(res, 'Select a valid country');
  if (!(await regionsFor(req.user)).includes(region)) return bad(res, 'You cannot raise notes for that region', 403);
  const submit = !!req.body.submit;
  if (submit && !o.objective.replace(/<[^>]*>/g, '').trim()) return bad(res, 'Please fill in the Objective before submitting');
  if (!o.no) o.no = await nextNoteNo();
  const now = new Date().toISOString();
  o.trail = [{ action: submit ? 'Submitted for approval' : 'Created draft', by: req.user.login_id, at: now }];
  o.createdAt = now; o.updatedAt = now; o.updatedBy = req.user.login_id;
  const r = await q('INSERT INTO notes(region,status,data,created_by) VALUES($1,$2,$3,$4) RETURNING *',
    [region, submit ? 'Submitted' : 'Draft', JSON.stringify(o), req.user.login_id]);
  res.json(noteOut(r.rows[0]));
}));

app.put('/api/notes/:id', auth, wrap(async (req, res) => {
  const n = await loadNote(req, res); if (!n) return;
  if (!['Draft', 'Returned'].includes(n.status)) return bad(res, 'Only drafts or returned notes can be edited');
  if (n.created_by !== req.user.login_id && !isAdmin(req.user)) return bad(res, 'Only the person who raised this note can edit it', 403);
  const o = cleanNote(req.body || {});
  const settings = await getSettings();
  const region = settings.countries[o.territory];
  if (!o.subject) return bad(res, 'Subject is required');
  if (!region || !(await regionsFor(req.user)).includes(region)) return bad(res, 'Select a valid country in your region');
  const submit = !!req.body.submit;
  if (submit && !o.objective.replace(/<[^>]*>/g, '').trim()) return bad(res, 'Please fill in the Objective before submitting');
  const old = parse(n.data);
  const now = new Date().toISOString();
  const trail = [...(old.trail || [])];
  if (submit) trail.push({ action: 'Submitted for approval', by: req.user.login_id, at: now });
  const data = { ...old, ...o, no: o.no || old.no, trail, updatedAt: now, updatedBy: req.user.login_id };
  const status = submit ? 'Submitted' : n.status;
  const r = await q('UPDATE notes SET region=$1,status=$2,data=$3,updated_at=NOW() WHERE id=$4 RETURNING *', [region, status, JSON.stringify(data), n.id]);
  res.json(noteOut(r.rows[0]));
}));

app.delete('/api/notes/:id', auth, wrap(async (req, res) => {
  const n = await loadNote(req, res); if (!n) return;
  const own = n.created_by === req.user.login_id && ['Draft', 'Returned'].includes(n.status);
  if (!own && !isSuper(req.user)) return bad(res, 'You cannot delete this note', 403);
  await q('DELETE FROM note_files WHERE note_id=$1', [n.id]);
  await q('DELETE FROM notes WHERE id=$1', [n.id]);
  res.json({ ok: true });
}));

app.post('/api/notes/:id/action', auth, wrap(async (req, res) => {
  const n = await loadNote(req, res); if (!n) return;
  const a = str(req.body.action, 20), comment = str(req.body.comment, 2000);
  const data = parse(n.data); const now = new Date().toISOString(); let status, label;
  if (['approve', 'return', 'reject'].includes(a)) {
    if (!isAdmin(req.user)) return bad(res, 'Only an admin can approve', 403);
    if (n.status !== 'Submitted') return bad(res, 'This note is not waiting for approval');
    if (a !== 'approve' && !comment) return bad(res, 'Please add a comment');
    status = { approve: 'Approved', return: 'Returned', reject: 'Rejected' }[a];
    label = { approve: 'Approved', return: 'Returned for changes', reject: 'Rejected' }[a];
  } else if (a === 'final') {
    if (!isSuper(req.user)) return bad(res, 'Only the super-admin can record final approval', 403);
    if (n.status !== 'Approved') return bad(res, 'Approve the note first');
    const cd = str(req.body.ceoDate, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cd)) return bad(res, 'Enter the CEO approval date');
    status = 'Final';
    const [y, m, d] = cd.split('-');
    label = `Finally approved (CEO paper approval dated ${d}-${m}-${y})`;
    data.ceoDate = cd; data.ceoRef = str(req.body.ceoRef, 100); data.ceoRemarks = comment;
  } else return bad(res, 'Unknown action');
  data.trail = [...(data.trail || []), { action: label, by: req.user.login_id, at: now, comment, step: status }];
  data.updatedAt = now; data.updatedBy = req.user.login_id;
  const r = await q('UPDATE notes SET status=$1,data=$2,updated_at=NOW() WHERE id=$3 RETURNING *', [status, JSON.stringify(data), n.id]);
  res.json(noteOut(r.rows[0]));
}));

/* Signed scans on approval notes (stored in the database) */
const FILE_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
app.post('/api/notes/:id/files', auth, express.raw({ type: Object.keys(FILE_TYPES), limit: '15mb' }), wrap(async (req, res) => {
  const n = await loadNote(req, res); if (!n) return;
  if (!isAdmin(req.user)) return bad(res, 'Only an admin can upload the signed copy', 403);
  if (!['Approved', 'Final'].includes(n.status)) return bad(res, 'Upload the signed copy after the note is approved');
  const mime = (req.get('Content-Type') || '').split(';')[0].trim();
  if (!FILE_TYPES[mime] || !Buffer.isBuffer(req.body) || !req.body.length) return bad(res, 'Upload a PDF, JPG or PNG file');
  let fname = 'signed-copy.' + FILE_TYPES[mime];
  try { fname = decodeURIComponent(req.get('X-Filename') || fname); } catch (e) {}
  fname = fname.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'signed-copy.' + FILE_TYPES[mime];
  await q('INSERT INTO note_files(note_id,filename,mime,size,data,uploaded_by) VALUES($1,$2,$3,$4,$5,$6)', [n.id, fname, mime, req.body.length, req.body, req.user.login_id]);
  const data = parse(n.data); const now = new Date().toISOString();
  data.trail = [...(data.trail || []), { action: `Signed copy uploaded: ${fname}`, by: req.user.login_id, at: now }];
  await q('UPDATE notes SET data=$1,updated_at=NOW() WHERE id=$2', [JSON.stringify(data), n.id]);
  res.json({ ok: true });
}));
app.get('/api/notes/:id/files/:fid', auth, wrap(async (req, res) => {
  const n = await loadNote(req, res); if (!n) return;
  const f = (await q('SELECT * FROM note_files WHERE id=$1 AND note_id=$2', [parseInt(req.params.fid, 10) || 0, n.id])).rows[0];
  if (!f) return bad(res, 'File not found', 404);
  res.setHeader('Content-Type', FILE_TYPES[f.mime] ? f.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${f.filename.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(f.data);
}));
app.delete('/api/notes/:id/files/:fid', auth, wrap(async (req, res) => {
  const n = await loadNote(req, res); if (!n) return;
  if (!isSuper(req.user)) return bad(res, 'Only the super-admin can remove a signed copy', 403);
  const f = (await q('SELECT filename FROM note_files WHERE id=$1 AND note_id=$2', [parseInt(req.params.fid, 10) || 0, n.id])).rows[0];
  if (!f) return bad(res, 'File not found', 404);
  await q('DELETE FROM note_files WHERE id=$1', [parseInt(req.params.fid, 10)]);
  const data = parse(n.data);
  data.trail = [...(data.trail || []), { action: `Signed copy removed: ${f.filename}`, by: req.user.login_id, at: new Date().toISOString() }];
  await q('UPDATE notes SET data=$1 WHERE id=$2', [JSON.stringify(data), n.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Priority sheet: partners (distributor / RA) with task lines         */
/* ------------------------------------------------------------------ */
const PARTNER = ['country', 'priority', 'type', 'partner', 'value'];
const istDate = (d = new Date()) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const taskOut = r => ({ ...parse(r.data), id: String(r.id), partnerId: String(r.partner_id), sort: r.sort });

async function partnersFor(user, regionFilter) {
  const regs = await regionsFor(user);
  const ps = (await q('SELECT * FROM priority ORDER BY sort, id')).rows.filter(x => regs.includes(x.region) && (!regionFilter || x.region === regionFilter));
  const ts = (await q('SELECT * FROM prio_tasks ORDER BY sort, id')).rows;
  const by = {};
  for (const t of ts) (by[t.partner_id] = by[t.partner_id] || []).push(taskOut(t));
  return ps.map(p => ({ ...parse(p.data), id: String(p.id), region: p.region, order: p.sort, tasks: by[p.id] || [] }));
}
app.get('/api/priority', auth, wrap(async (req, res) => res.json(await partnersFor(req.user))));

async function partnerBody(req, res) {
  const b = req.body || {}; const o = {};
  for (const k of PARTNER) o[k] = str(b[k], 200);
  if (!['VH', 'H', 'M'].includes(o.priority)) o.priority = 'M';
  if (!['Distributor', 'RA'].includes(o.type)) o.type = 'Distributor';
  const region = (await getSettings()).countries[o.country];
  if (!o.partner || !region) { bad(res, 'Country and distributor / RA name are required'); return null; }
  if (!(await regionsFor(req.user)).includes(region)) { bad(res, 'You cannot add rows in that region', 403); return null; }
  return { region, o };
}
function newTask(b, user) {
  const now = new Date().toISOString();
  const t = { task: str(b.task, 3000), tcd: isDate(b.tcd) ? b.tcd : '', tcdHistory: [], updates: [], status: 'Open', createdAt: now, createdBy: user.login_id, updatedAt: now, updatedBy: user.login_id };
  const up = str(b.update, 5000);
  if (up) t.updates.push({ on: istDate(), at: now, text: up, by: user.login_id });
  return t;
}
app.post('/api/priority', auth, wrap(async (req, res) => {
  const x = await partnerBody(req, res); if (!x) return;
  const data = { ...x.o, createdAt: new Date().toISOString(), createdBy: req.user.login_id };
  const r = await q('INSERT INTO priority(region,data,sort) VALUES($1,$2,(SELECT COALESCE(MAX(sort),0)+1 FROM priority)) RETURNING id', [x.region, JSON.stringify(data)]);
  const pid = r.rows[0].id; let i = 0;
  for (const t of (Array.isArray(req.body.tasks) ? req.body.tasks : []).slice(0, 50)) {
    if (!str(t.task)) continue;
    await q('INSERT INTO prio_tasks(partner_id,region,sort,data) VALUES($1,$2,$3,$4)', [pid, x.region, ++i, JSON.stringify(newTask(t, req.user))]);
  }
  res.json({ ok: true, id: String(pid) });
}));
async function loadPartner(req, res, id) {
  const r = await q('SELECT * FROM priority WHERE id=$1', [parseInt(id, 10) || 0]);
  const p = r.rows[0];
  if (!p || !(await regionsFor(req.user)).includes(p.region)) { bad(res, 'Distributor / RA not found', 404); return null; }
  return p;
}
app.put('/api/priority/:id', auth, wrap(async (req, res) => {
  const p = await loadPartner(req, res, req.params.id); if (!p) return;
  const x = await partnerBody(req, res); if (!x) return;
  const data = { ...parse(p.data), ...x.o, updatedAt: new Date().toISOString(), updatedBy: req.user.login_id };
  await q('UPDATE priority SET region=$1,data=$2,updated_at=NOW() WHERE id=$3', [x.region, JSON.stringify(data), p.id]);
  await q('UPDATE prio_tasks SET region=$1 WHERE partner_id=$2', [x.region, p.id]);
  res.json({ ok: true });
}));
app.delete('/api/priority/:id', auth, wrap(async (req, res) => {
  if (!isAdmin(req.user)) return bad(res, 'Only an admin can delete a distributor / RA', 403);
  const p = await loadPartner(req, res, req.params.id); if (!p) return;
  await q('DELETE FROM prio_tasks WHERE partner_id=$1', [p.id]);
  await q('DELETE FROM priority WHERE id=$1', [p.id]);
  res.json({ ok: true });
}));
app.post('/api/priority/:id/tasks', auth, wrap(async (req, res) => {
  const p = await loadPartner(req, res, req.params.id); if (!p) return;
  if (!str(req.body.task)) return bad(res, 'Enter the task');
  await q('INSERT INTO prio_tasks(partner_id,region,sort,data) VALUES($1,$2,(SELECT COALESCE(MAX(sort),0)+1 FROM prio_tasks WHERE partner_id=$1),$3)',
    [p.id, p.region, JSON.stringify(newTask(req.body, req.user))]);
  res.json({ ok: true });
}));
async function loadTask(req, res, id) {
  const r = await q('SELECT * FROM prio_tasks WHERE id=$1', [parseInt(id, 10) || 0]);
  const t = r.rows[0];
  if (!t || !(await regionsFor(req.user)).includes(t.region)) { bad(res, 'Task not found', 404); return null; }
  return t;
}
// Apply an edit / daily update to a task. Old TCD is kept in tcdHistory.
function applyTask(old, b, user) {
  const now = new Date().toISOString(); const t = { ...old, tcdHistory: [...(old.tcdHistory || [])], updates: [...(old.updates || [])] };
  if (b.task !== undefined && str(b.task)) t.task = str(b.task, 3000);
  if (b.tcd !== undefined && isDate(b.tcd) && b.tcd !== old.tcd) {
    if (old.tcd) t.tcdHistory.push({ tcd: old.tcd, changedOn: istDate(), at: now, by: user.login_id, reason: str(b.tcdReason, 500) });
    t.tcd = b.tcd;
  }
  if (b.status !== undefined && ['Open', 'Done', 'On hold'].includes(b.status) && b.status !== old.status) {
    t.status = b.status;
    t.updates.push({ on: istDate(), at: now, text: `Status changed to ${b.status}`, by: user.login_id, system: true });
  }
  const up = str(b.update, 5000);
  if (up) t.updates.push({ on: istDate(), at: now, text: up, by: user.login_id });
  if (t.updates.length > 400) t.updates = t.updates.slice(-400);
  t.updatedAt = now; t.updatedBy = user.login_id;
  return t;
}
app.put('/api/tasks/:id', auth, wrap(async (req, res) => {
  const t = await loadTask(req, res, req.params.id); if (!t) return;
  const nt = applyTask(parse(t.data), req.body || {}, req.user);
  await q('UPDATE prio_tasks SET data=$1,updated_at=NOW() WHERE id=$2', [JSON.stringify(nt), t.id]);
  res.json({ ok: true });
}));
app.delete('/api/tasks/:id', auth, wrap(async (req, res) => {
  if (!isAdmin(req.user)) return bad(res, 'Only an admin can delete a task', 403);
  const t = await loadTask(req, res, req.params.id); if (!t) return;
  await q('DELETE FROM prio_tasks WHERE id=$1', [t.id]);
  res.json({ ok: true });
}));
// Daily update: many tasks in one save.
app.post('/api/tasks/daily', auth, wrap(async (req, res) => {
  const items = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 500);
  let n = 0;
  for (const it of items) {
    const r = await q('SELECT * FROM prio_tasks WHERE id=$1', [parseInt(it.id, 10) || 0]);
    const t = r.rows[0];
    if (!t || !(await regionsFor(req.user)).includes(t.region)) continue;
    const b = { update: it.update, tcd: it.tcd, tcdReason: it.tcdReason, status: it.status };
    if (!str(b.update) && !(isDate(b.tcd) && b.tcd !== parse(t.data).tcd) && !(b.status && b.status !== parse(t.data).status)) continue;
    await q('UPDATE prio_tasks SET data=$1,updated_at=NOW() WHERE id=$2', [JSON.stringify(applyTask(parse(t.data), b, req.user)), t.id]);
    n++;
  }
  res.json({ ok: true, saved: n });
}));

/* Excel export – one sheet per region, plus a summary */
app.get('/api/priority/export.xlsx', auth, wrap(async (req, res) => {
  const ExcelJS = require('exceljs');
  const want = str(req.query.region, 80);
  const regs = await regionsFor(req.user);
  if (want && want !== 'ALL' && !regs.includes(want)) return bad(res, 'Not allowed', 403);
  const partners = await partnersFor(req.user, want && want !== 'ALL' ? want : null);
  const settings = await getSettings();
  const today = istDate();
  const dmy = s => (isDate(s) ? `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}` : '');
  const wb = new ExcelJS.Workbook(); wb.creator = 'Aculife-IB Portal'; wb.created = new Date();
  const NAVY = 'FF0B2A4A', PR = { VH: 'FFC0392B', H: 'FFD68910', M: 'FF2E86C1' };
  const head = (ws, cols) => {
    ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
    const r = ws.getRow(1);
    r.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { vertical: 'middle', wrapText: true }; });
    r.height = 30; ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const regionList = [...new Set(partners.map(p => p.region))].sort();
  // Summary
  const sum = wb.addWorksheet('Summary');
  head(sum, [['Region', 'region', 22], ['Distributors / RA', 'p', 16], ['Open tasks', 'open', 12], ['Done', 'done', 10], ['Updated today', 'upd', 15], ['Not updated today', 'notupd', 18], ['TCD overdue', 'over', 13]]);
  for (const rg of regionList) {
    const ps = partners.filter(p => p.region === rg); const ts = ps.flatMap(p => p.tasks); const open = ts.filter(t => t.status !== 'Done');
    const upd = open.filter(t => (t.updates || []).some(u => u.on === today && !u.system)).length;
    sum.addRow({ region: rg, p: ps.length, open: open.length, done: ts.length - open.length, upd, notupd: open.length - upd, over: open.filter(t => t.tcd && t.tcd < today).length });
  }
  sum.addRow({}); sum.addRow({ region: `Downloaded ${dmy(today)} by ${req.user.login_id}` }).font = { italic: true, color: { argb: 'FF777777' } };
  sum.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  for (const rg of regionList) {
    const ws = wb.addWorksheet(rg.replace(/[\\\/\?\*\[\]:]/g, ' ').slice(0, 31));
    head(ws, [['Country', 'country', 14], ['Class', 'cls', 7], ['Priority', 'priority', 9], ['Distributor / RA', 'type', 12], ['Name', 'partner', 22], ['Business value (USD Lac)', 'value', 12],
      ['#', 'n', 5], ['Task', 'task', 40], ['Current TCD', 'tcd', 13], ['Previous TCD(s)', 'prevTcd', 22], ['Latest update on', 'lastOn', 13], ['Latest update', 'last', 50],
      ['Previous update on', 'prevOn', 13], ['Previous update', 'prev', 40], ['Status', 'status', 10], ['Updated today', 'today', 10], ['Last updated by', 'by', 16]]);
    for (const p of partners.filter(x => x.region === rg)) {
      const tasks = p.tasks.length ? p.tasks : [{ task: '', updates: [], tcdHistory: [] }];
      const first = ws.rowCount + 1;
      tasks.forEach((t, i) => {
        const ups = (t.updates || []).filter(u => !u.system); const last = ups[ups.length - 1], prev = ups[ups.length - 2];
        const row = ws.addRow({ country: p.country, cls: settings.classes?.[p.country] || '', priority: p.priority, type: p.type, partner: p.partner, value: p.value, n: t.task ? i + 1 : '',
          task: t.task, tcd: dmy(t.tcd), prevTcd: (t.tcdHistory || []).map(h => dmy(h.tcd) + (h.reason ? ` (${h.reason})` : '')).reverse().join('\n'),
          lastOn: last ? dmy(last.on) : '', last: last ? last.text : '', prevOn: prev ? dmy(prev.on) : '', prev: prev ? prev.text : '',
          status: t.task ? (t.status || 'Open') : '', today: t.task && t.status !== 'Done' ? (ups.some(u => u.on === today) ? 'Yes' : 'No') : '', by: t.updatedBy || '' });
        row.alignment = { vertical: 'top', wrapText: true };
        row.eachCell({ includeEmpty: true }, c => { c.border = { top: { style: 'thin', color: { argb: 'FFBFC7D1' } }, bottom: { style: 'thin', color: { argb: 'FFBFC7D1' } }, left: { style: 'thin', color: { argb: 'FFBFC7D1' } }, right: { style: 'thin', color: { argb: 'FFBFC7D1' } } }; });
        if (t.tcd && t.tcd < today && t.status !== 'Done') row.getCell('tcd').font = { bold: true, color: { argb: 'FFC0392B' } };
        if (row.getCell('today').value === 'No') row.getCell('today').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDEBD0' } };
        if (row.getCell('today').value === 'Yes') row.getCell('today').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD5F5E3' } };
        row.getCell('prevTcd').font = { color: { argb: 'FF7F8C8D' }, strike: false };
      });
      const lastRow = ws.rowCount;
      const pc = ws.getRow(first).getCell('priority');
      pc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PR[p.priority] || PR.M } }; pc.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(first).getCell('partner').font = { bold: true };
      if (lastRow > first) for (const k of ['country', 'cls', 'priority', 'type', 'partner', 'value']) {
        const col = ws.getColumn(k).number; ws.mergeCells(first, col, lastRow, col);
      }
    }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 17 } };
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  }
  if (!regionList.length) wb.addWorksheet('No data').addRow(['No priority rows for this selection.']);
  const name = `Aculife-IB_Priority_Sheet_${want && want !== 'ALL' ? want.replace(/\s+/g, '_') : 'All_Regions'}_${today}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  await wb.xlsx.write(res); res.end();
}));

/* ------------------------------------------------------------------ */
/* Login IDs (super-admin only)                                        */
/* ------------------------------------------------------------------ */
const superOnly = (req, res, next) => (isSuper(req.user) ? next() : bad(res, 'Only the super-admin can manage login IDs', 403));
const userOut = u => ({ id: u.id, loginId: u.login_id, name: u.name, role: u.role, region: u.region, active: u.active, createdAt: u.created_at });
const idFor = r => 'IB-' + r.toUpperCase().replace(/[^A-Z0-9]/g, '');

app.get('/api/users', auth, superOnly, wrap(async (req, res) => {
  const r = await q('SELECT * FROM users ORDER BY role DESC, region, login_id');
  res.json(r.rows.map(userOut));
}));
app.post('/api/users', auth, superOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const login = str(b.loginId, 40).toUpperCase().replace(/\s+/g, '-');
  if (!/^[A-Z0-9._-]{3,40}$/.test(login)) return bad(res, 'Login ID: 3–40 letters, numbers, - _ .');
  const role = ['admin', 'region'].includes(b.role) ? b.role : 'region';
  const regs = (await getSettings()).regions;
  const region = role === 'region' ? str(b.region, 80) : '';
  if (role === 'region' && !regs.includes(region)) return bad(res, 'Choose a region');
  let pw = String(b.password || '');
  if (pw && pw.length < 8) return bad(res, 'Password must be at least 8 characters');
  if (!pw) pw = newPassword();
  const ex = await q('SELECT id FROM users WHERE login_id=$1', [login]);
  if (ex.rows.length) return bad(res, 'That Login ID already exists');
  await q('INSERT INTO users(login_id,name,role,region,password_hash) VALUES($1,$2,$3,$4,$5)', [login, str(b.name, 100), role, region, bcrypt.hashSync(pw, 11)]);
  res.json({ loginId: login, password: pw, region });
}));
app.post('/api/users/generate', auth, superOnly, wrap(async (req, res) => {
  const regs = (await getSettings()).regions;
  const all = (await q('SELECT login_id,role,region FROM users')).rows;
  const out = [];
  for (const r of regs) {
    if (all.some(u => u.role === 'region' && u.region === r)) continue;
    let id = idFor(r), k = 2;
    while (all.some(u => u.login_id === id)) id = idFor(r) + k++;
    const pw = newPassword();
    await q('INSERT INTO users(login_id,name,role,region,password_hash) VALUES($1,$2,$3,$4,$5)', [id, r + ' team', 'region', r, bcrypt.hashSync(pw, 11)]);
    all.push({ login_id: id, role: 'region', region: r });
    out.push({ loginId: id, password: pw, region: r });
  }
  res.json(out);
}));
app.put('/api/users/:id', auth, superOnly, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const u = (await q('SELECT * FROM users WHERE id=$1', [id])).rows[0];
  if (!u) return bad(res, 'Not found', 404);
  if (u.role === 'super') return bad(res, 'The super-admin cannot be changed here');
  const b = req.body || {};
  const active = typeof b.active === 'boolean' ? b.active : u.active;
  await q('UPDATE users SET active=$1 WHERE id=$2', [active, id]);
  if (!active) await q('DELETE FROM sessions WHERE user_id=$1', [id]);
  res.json({ ok: true });
}));
app.post('/api/users/:id/reset', auth, superOnly, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const u = (await q('SELECT * FROM users WHERE id=$1', [id])).rows[0];
  if (!u) return bad(res, 'Not found', 404);
  const pw = newPassword();
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(pw, 11), id]);
  await q('DELETE FROM sessions WHERE user_id=$1', [id]);
  res.json({ loginId: u.login_id, password: pw, region: u.region });
}));
app.delete('/api/users/:id', auth, superOnly, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const u = (await q('SELECT * FROM users WHERE id=$1', [id])).rows[0];
  if (!u) return bad(res, 'Not found', 404);
  if (u.role === 'super') return bad(res, 'The super-admin cannot be deleted');
  await q('DELETE FROM sessions WHERE user_id=$1', [id]);
  await q('DELETE FROM users WHERE id=$1', [id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Static site                                                         */
/* ------------------------------------------------------------------ */
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/vendor/jspdf.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/jspdf/dist/jspdf.umd.min.js')));
app.get('/vendor/jspdf-autotable.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/jspdf-autotable/dist/jspdf.plugin.autotable.min.js')));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: PROD ? '1h' : 0 }));
app.use('/api', (req, res) => bad(res, 'Not found', 404));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return bad(res, 'This note is too large – remove or crop some images.', 413);
  console.error(err);
  bad(res, 'Something went wrong. Please try again.', 500);
});

(async () => {
  if (!pool) pool = await connectPg();
  await migrate();
  await seed();
  app.listen(PORT, () => console.log(`Aculife-IB Portal running on port ${PORT}`));
})().catch(e => { console.error('Startup failed:', e); process.exit(1); });

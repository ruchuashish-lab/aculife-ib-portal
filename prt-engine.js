/*
 * Aculife-IB Portal – PRT (Product Registration Tracker) regulatory engine.
 * Reads the "PRT" sheet (or "PRT + BUSINESS") of the PRT_VS_BUSINESS workbook, plus the "Products"
 * master sheet (generic name -> product group / therapy / mfg unit) when present.
 * Focus: registrations, renewals & expiries, MOH reviews, partner queries, pending documents & fees.
 * Counts are registrations (one PRT ID = one country × SKU). No business values.
 * Shared by the server (Node) and the browser preview.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PrtEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const cellVal = v => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v;
    if (typeof v === 'object') { if ('result' in v) return cellVal(v.result); if (v.richText) return v.richText.map(t => t.text).join(''); if ('text' in v) return v.text; return ''; }
    return v;
  };
  const norm = s => String(s == null ? '' : s).toUpperCase().replace(/\s+/g, ' ').trim();
  const hkey = s => norm(s).replace(/[^A-Z0-9]/g, '');
  const one = s => String(s == null ? '' : s).replace(/_x000D_/g, '').replace(/\s+/g, ' ').trim();
  const txt = (v, max) => { const s = cellVal(v); if (s instanceof Date) return iso(s); return one(s).slice(0, max || 200); };
  function iso(v) {
    v = cellVal(v);
    if (v instanceof Date) { if (isNaN(v)) return ''; const y = v.getUTCFullYear(); return y < 1950 || y > 2100 ? '' : v.toISOString().slice(0, 10); }
    if (typeof v === 'number' && v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 864e5)); return d.toISOString().slice(0, 10); }
    const s = String(v || '').trim(); const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m && +m[1] >= 1950 && +m[1] <= 2100) return m[0];
    return '';
  }
  // column name -> field (header names are matched without spaces/punctuation, case-insensitive)
  const COLS = {
    id: ['ID'], region: ['COUNTRYREGION', 'REGION2', 'REGION'], country: ['COUNTRY'], gen: ['GENERICNAME'], brand: ['BRANDNAME'],
    st: ['CURRENTSTATUS'], pri: ['PRIORITYNONPRIORITY', 'PRIORITY'], dcat: ['CATEGORY'], ddPlan: ['DOSSIERDISPATCHPLANDATE'], dsent: ['DOSSIERSSENTDATE'],
    planMoh: ['PLANMOHSUBDATE'], mohSub: ['MOHSUBMISSIONDATE'], tent: ['TENTATIVEREGEXPECTEDDATE'], initReg: ['INITIALREGDATE'], regDate: ['REGISTRATIONDATE'],
    renew: ['RENEWALDATE'], freq: ['RENEWALFREQUENCY'], regNo: ['REGISTRATIONNO'], regSt: ['REGISTRATIONSTATUS'], regNew: ['REGISTRATIONSTATUSNEW'], status2: ['STATUS'],
    rc: ['RCAVAILABILITY'], verified: ['VERIFIED'], dist: ['DISTRIBUTOR'], agent: ['CONSULTANTNAME'], ra: ['RARESOURCE'], raOwner: ['COUNTRYREGULATORYAGENCY'],
    bdm: ['COUNTRYBDM', 'BDM'], samples: ['SAMPLESDISPATCHTEXT'], sampleDt: ['SAMPLEDISPATCHDATE'], legal: ['LEGALDOCSUBMISSIONTEXT'], mohFee: ['MOHFEESSTATUS'],
    agFee: ['AGENTSFEESSTATUS'], remarks: ['REGULATORYREMARKS'], comm: ['ALLCOMMENTS'], dtype: ['DOSSIERTYPE'], dos: ['DOSSIERAVAILABLE'], regType: ['REGTYPE'],
    pharm: ['PHARMACOPOEIA'], mfg: ['TABLEPRODUCTMASTERMFGUNIT'], tc: ['TABLEPRODUCTMASTERTC'], pg: ['TABLEPRODUCTMASTERPRODUCTGROUP'], cat: ['COUNTRYCAT']
  };
  const REQ = ['id', 'country', 'gen', 'st'];
  const PCOLS = { gen: ['GENERICNAME'], pg: ['PRODUCTGROUP'], tc: ['TC'], mfg: ['MFGUNIT'], mol: ['MOLECULE'] };
  const prodName = r => r.mol || r.pg || '—';
  // newest comment entry (comments are kept newest-first)
  function latest(v) {
    const s = String(cellVal(v) || '').replace(/_x000D_/g, '').replace(/\r/g, '').trim(); if (!s) return '';
    const parts = s.split(/\n\s*\n|\n(?=\s*(?:\d{1,3}[.)]\s|•|[-*]\s|\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}|[A-Za-z]{3,9}[ ,.'-]*\d{2,4}\s*[-:]|on\s+\d))/i).map(x => x.trim()).filter(Boolean);
    return (parts[0] || '').replace(/\s*\n\s*/g, ' · ').slice(0, 300);
  }
  const cleanRemark = v => { const s = String(cellVal(v) || '').trim(); if (!s || /<a\s/i.test(s)) return ''; return one(s).slice(0, 200); };
  const findCols = (head, map) => { const m = {}; for (const [k, names] of Object.entries(map)) { m[k] = -1; for (const n of names) { const i = head.indexOf(n); if (i >= 0) { m[k] = i; break; } } } return m; };

  function parser() {
    let mode = null, idx = null; const rows = [], seen = new Set(), prod = new Map(), flag = new Map(); let skipped = 0, dup = 0, hasPg = false, hasPri = false, gotPrt = false, gotProd = false, gotFlag = false;
    return {
      header(values) {
        const head = values.map(v => hkey(cellVal(v)));
        mode = null;
        if (!gotPrt) { const m = findCols(head, COLS); if (!REQ.some(k => m[k] < 0)) { idx = m; mode = 'prt'; hasPg = m.pg >= 0; hasPri = m.pri >= 0 && head[m.pri] === 'PRIORITYNONPRIORITY'; return true; } }
        if (gotPrt && !hasPri && !gotFlag) { const i = head.indexOf('ID'), j = head.indexOf('PRIORITYNONPRIORITY'), c = head.indexOf('COUNTRYCAT'); if (i >= 0 && j >= 0) { idx = { id: i, pri: j, cat: c }; mode = 'flag'; return true; } }
        if (!gotProd) { const m = findCols(head, PCOLS); if (m.gen >= 0 && m.pg >= 0 && m.tc >= 0 && head.indexOf('COUNTRY') < 0) { idx = m; mode = 'prod'; return true; } }
        return false;
      },
      row(values) {
        const g = k => (idx[k] >= 0 ? values[idx[k]] : '');
        if (mode === 'prod') { gotProd = true; const k = norm(txt(g('gen'), 200)); if (k && !prod.has(k)) prod.set(k, { pg: txt(g('pg'), 80), tc: txt(g('tc'), 60), mfg: txt(g('mfg'), 40), mol: txt(g('mol'), 60) }); return; }
        if (mode === 'flag') { gotFlag = true; const id = txt(g('id'), 40); if (id && !flag.has(id)) flag.set(id, [norm(txt(g('pri'), 20)) === 'PRIORITY', txt(g('cat'), 4)]); return; }
        if (mode !== 'prt') return;
        gotPrt = true;
        const id = txt(g('id'), 40); if (!id) { skipped++; return; }
        if (seen.has(id)) { dup++; return; } seen.add(id);
        const pri = norm(txt(g('pri'), 20));
        rows.push({
          id, region: txt(g('region'), 60), country: txt(g('country'), 60), cat: txt(g('cat'), 4), gen: txt(g('gen'), 160), brand: txt(g('brand'), 80),
          st: txt(g('st'), 40) || '(blank)', pri: pri === 'PRIORITY' || pri === 'TRUE' || pri === 'YES' ? 'Priority' : 'Non-priority', dcat: txt(g('dcat'), 80),
          ddPlan: iso(g('ddPlan')), dsent: iso(g('dsent')), planMoh: iso(g('planMoh')), mohSub: iso(g('mohSub')), tent: iso(g('tent')),
          reg: iso(g('regDate')) || iso(g('initReg')), renew: iso(g('renew')), freq: txt(g('freq'), 24), regNo: txt(g('regNo'), 60), regSt: txt(g('regSt'), 20), regNew: txt(g('regNew'), 40),
          status2: txt(g('status2'), 30), rc: /^(TRUE|YES|1)$/i.test(String(cellVal(g('rc')))), verified: /^(TRUE|YES|1)$/i.test(String(cellVal(g('verified')))),
          dist: txt(g('dist'), 80), agent: txt(g('agent'), 60), ra: txt(g('ra'), 60), raOwner: txt(g('raOwner'), 60), bdm: txt(g('bdm'), 60),
          samples: txt(g('samples'), 120), sampleDt: iso(g('sampleDt')), legal: txt(g('legal'), 120), mohFee: txt(g('mohFee'), 20), agFee: txt(g('agFee'), 20),
          remarks: cleanRemark(g('remarks')), comm: latest(g('comm')), dtype: txt(g('dtype'), 20), dos: txt(g('dos'), 10), regType: txt(g('regType'), 20), pharm: txt(g('pharm'), 20),
          mfg: txt(g('mfg'), 40), tc: txt(g('tc'), 60), pg: txt(g('pg'), 80)
        });
      },
      done() { return gotPrt && (gotProd || hasPg) && (hasPri || gotFlag); },
      finish(info) {
        if (!rows.length) throw new Error('Could not find the PRT sheet (columns ID, Country, Generic Name, Current Status …).');
        let matched = 0;
        if (flag.size) for (const r of rows) { const f = flag.get(r.id); if (f) { r.pri = f[0] ? 'Priority' : 'Non-priority'; if (!r.cat && f[1]) r.cat = f[1]; } }
        for (const r of rows) { const p = prod.get(norm(r.gen)); if (p) { matched++; r.pg = r.pg || p.pg; r.tc = r.tc || p.tc; r.mfg = r.mfg || p.mfg; r.mol = p.mol; } }
        return { kind: 'PRT', rows, meta: { rows: rows.length, registrations: rows.length, countries: new Set(rows.map(r => norm(r.country))).size, products: new Set(rows.map(r => r.gen)).size, skipped, duplicates: dup, productMaster: prod.size, productMatched: matched, ...(info || {}) } };
      }
    };
  }
  function parseWorkbook(wb, info) {
    const p = parser();
    for (const ws of wb.worksheets) {
      let first = true, use = false;
      ws.eachRow({ includeEmpty: false }, row => { const v = row.values.slice(1); if (first) { first = false; use = p.header(v); return; } if (use) p.row(v); });
      if (p.done()) break;
    }
    return p.finish(info);
  }

  /* ---------------- status groups & dates ---------------- */
  // g: reg | ren | moh | dist | hold | plan | lost | oth
  const GROUP = s => { const u = norm(s); if (u === 'APPROVED') return 'reg'; if (u === 'UNDER RENEWAL' || u === 'TO BE RENEWED') return 'ren'; if (u === 'MOH') return 'moh';
    if (u === 'WITH DISTRIBUTOR') return 'dist'; if (u === 'PLAN') return 'plan'; if (u === 'ON HOLD') return 'hold'; if (u === 'CANCELLED' || u === 'REJECTED' || u === 'TO BE DELETED') return 'lost'; return 'oth'; };
  const GLABEL = { reg: 'Registered', ren: 'Under renewal', moh: 'Under MOH review', dist: 'Dossier with distributor / agent', plan: 'Plan (not started)', hold: 'On hold', lost: 'Lost (cancelled / rejected / deleted)', oth: 'Status blank' };
  const GORDER = ['reg', 'ren', 'moh', 'dist', 'plan', 'hold', 'lost', 'oth'];
  const RALIAS = { 'GLOBAL INSTITUTION': 'Global Aid', 'FWA': 'French West Africa' };
  const titleCase = u => u.toLowerCase().replace(/(^|[\s(\/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  function regMapper(settings) {
    const regs = {}; (settings.regions || []).forEach(r => { regs[norm(r)] = r; });
    const cty = {}; Object.entries(settings.countries || {}).forEach(([c, r]) => { cty[norm(c)] = r; });
    return (raw, country) => { const u = norm(raw); if (regs[u]) return regs[u]; if (RALIAS[u] && regs[norm(RALIAS[u])]) return regs[norm(RALIAS[u])];
      const c = cty[norm(country)]; if (c) return c; return u ? titleCase(u) : 'Unmapped'; };
  }
  function today() { const d = new Date(Date.now() + 330 * 60000); return d.toISOString().slice(0, 10); }
  const dnum = s => Date.parse(s + 'T00:00:00Z') / 864e5;
  const monthsSince = (s, t) => (s ? (dnum(t) - dnum(s)) / 30.44 : null);
  const LIFETIME = /LIFE|INDEF|INFINI/i;
  // expiry bucket for registered / under-renewal records
  const EXP = ['Expired, not filed', 'Expired, renewal filed', 'Due 0–3 months', 'Due 3–6 months', 'Due 6–12 months', 'Due 1–2 years', '2+ years', 'Lifetime', 'No date'];
  function expiry(r, g, t) {
    if (g !== 'reg' && g !== 'ren') return '';
    if (LIFETIME.test(r.freq)) return 'Lifetime';
    if (!r.renew) return norm(r.regSt) === 'EXPIRED' ? (g === 'ren' ? 'Expired, renewal filed' : 'Expired, not filed') : 'No date';
    const m = (dnum(r.renew) - dnum(t)) / 30.44;
    if (m < 0) return g === 'ren' ? 'Expired, renewal filed' : 'Expired, not filed';
    return m < 3 ? 'Due 0–3 months' : m < 6 ? 'Due 3–6 months' : m < 12 ? 'Due 6–12 months' : m < 24 ? 'Due 1–2 years' : '2+ years';
  }
  const AGE = ['< 6 months', '6–12 months', '1–2 years', '2–3 years', '3+ years', 'No date'];
  const ageBand = m => (m == null ? 'No date' : m < 6 ? '< 6 months' : m < 12 ? '6–12 months' : m < 24 ? '1–2 years' : m < 36 ? '2–3 years' : '3+ years');
  // queries: latest comment / regulatory remark
  const NOQ = /\bno (pending )?quer(y|ies)\b|\bno quer(y|ies) pending\b|quer(y|ies) (is |are )?(closed|resolved)|without any quer/i;
  const QRY = /\bquer(y|ies)\b|deficien|clarification|observation|objection|\bcomments? (received|from moh)|\bevaluation (report|comments)/i;
  const RESP = /respon(ded|se (sent|submitted|given|shared|filed))|quer(y|ies) (response )?submitted|repl(ied|y sent)|resolved|answered|submitted (the )?(response|reply)|addressed/i;
  const AWAIT = /AWAITED|PENDING|TECHNICAL QUERY|FOLLOW-UP|OOT IN STABILITY|TO BE RELABEL|NEED TO RELABEL|GAP ANALYSIS|UNDER .*TRANSLATION|NOT (ARE )?AVA/i;
  function query(r, g) {
    if (g === 'lost') return '';
    const c = r.comm || '';
    if (NOQ.test(c) || /^NO QUERY PENDING/i.test(r.remarks)) return '';
    if (QRY.test(c)) return RESP.test(c) ? 'Responded – awaiting MOH / partner' : 'Open query';
    if (r.remarks && AWAIT.test(r.remarks)) return 'Awaiting partner / client input';
    return '';
  }
  const PEND = /PEND|NOT SEN|NOT SEND|AWAIT|TO BE SEN|NOT YET|HALF/i;
  const pend = s => !!s && PEND.test(s) && !/NOT REQUIR/i.test(s);

  function scopeRows(ds, scope, settings) {
    if (!ds) return [];
    const reg = regMapper(settings); const cls = {}; Object.entries(settings.classes || {}).forEach(([c, v]) => { cls[norm(c)] = v; });
    const t = today(); const out = [];
    for (const r of ds.rows) {
      const region = reg(r.region, r.country);
      if (!scope.admin && !scope.regions.includes(region)) continue;
      if (scope.region && scope.region !== 'ALL' && region !== scope.region) continue;
      const g = GROUP(r.st);
      const it = { r, region, cat: r.cat || cls[norm(r.country)] || '—', g, exp: expiry(r, g, t), q: query(r, g) };
      it.ageMoh = g === 'moh' ? monthsSince(r.mohSub, t) : null;
      it.ageDist = g === 'dist' ? monthsSince(r.dsent, t) : null;
      it.pS = g !== 'lost' && g !== 'reg' && pend(r.samples); it.pL = g !== 'lost' && g !== 'reg' && pend(r.legal);
      it.pM = g !== 'lost' && pend(r.mohFee); it.pA = g !== 'lost' && pend(r.agFee);
      it.tentPassed = ['moh', 'dist'].includes(g) && r.tent && r.tent < t;
      it.planPassed = g === 'plan' && r.ddPlan && r.ddPlan < t;
      out.push(it);
    }
    return out;
  }
  const ACTIVE = g => g !== 'lost' && g !== 'oth';
  const isExpired = it => it.exp === 'Expired, not filed';
  const due6 = it => it.exp === 'Due 0–3 months' || it.exp === 'Due 3–6 months';
  const due12 = it => due6(it) || it.exp === 'Due 6–12 months';

  // group registrations by key -> status / expiry / query counts
  function group(items, keyFn, withCountries) {
    const map = new Map();
    const mk = () => ({ n: 0, reg: 0, ren: 0, moh: 0, dist: 0, plan: 0, hold: 0, lost: 0, oth: 0, exp: 0, renF: 0, d6: 0, d12: 0, oq: 0, pend: 0, cReg: withCountries ? new Set() : null, cAll: withCountries ? new Set() : null });
    const tot = mk();
    const add = (a, it) => { a.n++; a[it.g]++; if (isExpired(it)) a.exp++; if (it.exp === 'Expired, renewal filed') a.renF++; if (due6(it)) a.d6++; else if (it.exp === 'Due 6–12 months') a.d12++;
      if (it.q === 'Open query' || it.q === 'Awaiting partner / client input') a.oq++; if (it.pS || it.pL || it.pM || it.pA) a.pend++;
      if (withCountries) { a.cAll.add(norm(it.r.country)); if ((it.g === 'reg' || it.g === 'ren') && !isExpired(it)) a.cReg.add(norm(it.r.country)); } };
    for (const it of items) {
      const key = keyFn(it); const ks = key.map(x => String(x).toUpperCase()).join('\u0001');
      let gr = map.get(ks); if (!gr) { gr = { key, a: mk() }; map.set(ks, gr); }
      add(gr.a, it); add(tot, it);
    }
    const fin = a => { const act = a.n - a.lost - a.oth; const o = { n: a.n, act, reg: a.reg, ren: a.ren, moh: a.moh, dist: a.dist, plan: a.plan, hold: a.hold, lost: a.lost, exp: a.exp, renF: a.renF, d6: a.d6, d12: a.d12, oq: a.oq, pend: a.pend,
      valid: a.reg - a.exp, regPct: act ? (a.reg + a.ren) / act : null };
      if (withCountries) { o.cAll = a.cAll.size; o.cReg = a.cReg.size; } return o; };
    const rows = [...map.values()].map(gr => { const o = fin(gr.a); gr.key.forEach((v, i) => { o['k' + i] = v; }); return o; }).sort((x, y) => y.act - x.act || y.n - x.n || String(x.k0).localeCompare(String(y.k0)));
    return { rows, total: { ...fin(tot), k0: 'TOTAL' } };
  }
  const statusCols = (keyCols, withCountries) => [...keyCols.map((l, i) => ({ k: 'k' + i, l, f: 't' })),
    ...(withCountries ? [{ k: 'cAll', l: 'Countries in PRT', f: 'n' }, { k: 'cReg', l: 'Countries registered (valid)', f: 'n', hl: 1 }] : []),
    { k: 'act', l: 'Active registrations', f: 'n' }, { k: 'reg', l: 'Registered', f: 'n', hl: 1 }, { k: 'ren', l: 'Under renewal', f: 'n' }, { k: 'moh', l: 'Under MOH', f: 'n' },
    { k: 'dist', l: 'With distributor / agent', f: 'n' }, { k: 'plan', l: 'Plan', f: 'n' }, { k: 'hold', l: 'On hold', f: 'n' }, { k: 'lost', l: 'Lost', f: 'n' },
    { k: 'exp', l: 'Expired, not filed', f: 'n', hl: 1 }, { k: 'renF', l: 'Expired, renewal filed', f: 'n' }, { k: 'd6', l: 'Renewal due ≤ 6 m', f: 'n' }, { k: 'd12', l: 'Renewal due 6–12 m', f: 'n' },
    { k: 'oq', l: 'Open queries', f: 'n' }, { k: 'pend', l: 'Pending docs / fees', f: 'n' }, { k: 'regPct', l: 'Registered % of active', f: 'p' }];
  const tbl = (title, keyCols, grp, limit, note, withCountries) => { let rows = grp.rows; const n = rows.length; if (limit) rows = rows.slice(0, limit);
    return { title, cols: statusCols(keyCols, withCountries), rows, total: grp.total, note: limit && n > limit ? `Top ${limit} of ${n} by active registrations shown${note ? ' – ' + note : ''}.` : '' }; };
  // simple bucket table: label -> count
  function buckets(title, labels, items, fn, note) {
    const m = new Map(labels.map(l => [l, 0])); for (const it of items) { const b = fn(it); if (b == null || b === '') continue; m.set(b, (m.get(b) || 0) + 1); }
    const rows = [...m.entries()].map(([k0, n]) => ({ k0, n })); const total = { k0: 'TOTAL', n: rows.reduce((a, r) => a + r.n, 0) };
    return { title, cols: [{ k: 'k0', l: 'Bucket', f: 't' }, { k: 'n', l: 'Registrations', f: 'n', hl: 1 }], rows, total, note: note || '' };
  }
  function renewCalendar(items) {
    const t = today(); const d = new Date(t.slice(0, 7) + '-01T00:00:00Z'); const months = [];
    for (let i = 0; i < 12; i++) { const x = new Date(d); x.setUTCMonth(d.getUTCMonth() + i); months.push(x.toISOString().slice(0, 7)); }
    const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const rows = months.map(m => { const its = items.filter(it => (it.g === 'reg' || it.g === 'ren') && it.exp !== 'Lifetime' && it.r.renew && it.r.renew >= t && it.r.renew.slice(0, 7) === m);
      return { k0: `${MN[+m.slice(5) - 1]}-${m.slice(2, 4)}`, n: its.length, reg: its.filter(x => x.g === 'reg').length, ren: its.filter(x => x.g === 'ren').length, c: new Set(its.map(x => norm(x.r.country))).size }; });
    const total = { k0: 'TOTAL' };['n', 'reg', 'ren'].forEach(k => { total[k] = rows.reduce((a, r) => a + r[k], 0); });
    return { title: 'Renewal calendar – next 12 months from today (by renewal / expiry date)', cols: [{ k: 'k0', l: 'Month', f: 't' }, { k: 'n', l: 'Renewals due', f: 'n', hl: 1 }, { k: 'reg', l: 'Not yet filed (Approved)', f: 'n' }, { k: 'ren', l: 'Renewal already filed', f: 'n' }, { k: 'c', l: 'Countries', f: 'n' }], rows, total };
  }

  /* ---------------- record lists ---------------- */
  const LCOLS = {
    country: { k: 'country', l: 'Country', f: 't' }, region: { k: 'region', l: 'Region', f: 't' }, gen: { k: 'gen', l: 'Product (SKU)', f: 't' }, pg: { k: 'pg', l: 'Product', f: 't' },
    brand: { k: 'brand', l: 'Brand', f: 't' }, st: { k: 'st', l: 'Current status', f: 's2' }, regNo: { k: 'regNo', l: 'Registration no.', f: 't' }, reg: { k: 'reg', l: 'Registration date', f: 'd' },
    renew: { k: 'renew', l: 'Renewal / expiry date', f: 'd', hl: 1 }, exp: { k: 'exp', l: 'Expiry bucket', f: 't' }, freq: { k: 'freq', l: 'Renewal frequency', f: 't' },
    mohSub: { k: 'mohSub', l: 'MOH submission', f: 'd' }, dsent: { k: 'dsent', l: 'Dossier sent', f: 'd' }, age: { k: 'age', l: 'Months', f: 'n', hl: 1 }, tent: { k: 'tent', l: 'Tentative reg. date', f: 'd' },
    ddPlan: { k: 'ddPlan', l: 'Dossier dispatch plan', f: 'd' }, planMoh: { k: 'planMoh', l: 'Plan MOH submission', f: 'd' },
    dist: { k: 'dist', l: 'Distributor', f: 't' }, agent: { k: 'agent', l: 'Agent / consultant', f: 't' }, ra: { k: 'ra', l: 'RA owner', f: 't' },
    dcat: { k: 'dcat', l: 'Blocker / delay reason', f: 't' }, q: { k: 'q', l: 'Query status', f: 't', hl: 1 }, remarks: { k: 'remarks', l: 'Regulatory remark', f: 'tl' }, comm: { k: 'comm', l: 'Latest comment', f: 'tl' },
    samples: { k: 'samples', l: 'Samples', f: 't' }, legal: { k: 'legal', l: 'Legal docs', f: 't' }, mohFee: { k: 'mohFee', l: 'MOH fees', f: 't' }, agFee: { k: 'agFee', l: "Agent's fees", f: 't' },
    issue: { k: 'issue', l: 'Issue', f: 't', hl: 1 }, pri: { k: 'pri', l: 'Priority', f: 't' }, dos: { k: 'dos', l: 'Dossier available', f: 't' }, dtype: { k: 'dtype', l: 'Dossier type', f: 't' }, id: { k: 'id', l: 'PRT ID', f: 't' }
  };
  const recOf = (it, extra) => ({ id: it.r.id, country: it.r.country, region: it.region, gen: it.r.gen, pg: prodName(it.r), brand: it.r.brand, st: it.r.st, regNo: it.r.regNo, reg: it.r.reg, renew: it.r.renew,
    exp: it.exp, freq: it.r.freq, mohSub: it.r.mohSub, dsent: it.r.dsent, tent: it.r.tent, ddPlan: it.r.ddPlan, planMoh: it.r.planMoh, dist: it.r.dist, agent: it.r.agent, ra: it.r.raOwner || it.r.ra,
    dcat: it.r.dcat, q: it.q, remarks: it.r.remarks, comm: it.r.comm, samples: it.r.samples, legal: it.r.legal, mohFee: it.r.mohFee, agFee: it.r.agFee, pri: it.r.pri, dos: it.r.dos, dtype: it.r.dtype, ...(extra || {}) });
  const list = (title, keys, rows, lim, note) => { const n = rows.length; return { title: `${title} (${n.toLocaleString('en-IN')})`, cols: keys.map(k => LCOLS[k]), rows: lim ? rows.slice(0, lim) : rows,
    note: lim && n > lim ? `First ${lim} of ${n} shown${note ? ' – ' + note : ''}.` : (note && !lim ? note : '') }; };
  const byDate = k => (a, b) => String(a[k] || '9999').localeCompare(String(b[k] || '9999')) || a.country.localeCompare(b.country);
  const sets = {
    expired: items => items.filter(isExpired).map(it => recOf(it)).sort((a, b) => String(b.renew).localeCompare(String(a.renew)) || a.country.localeCompare(b.country)),
    due: items => items.filter(due12).map(it => recOf(it)).sort(byDate('renew')),
    renFiled: items => items.filter(it => it.exp === 'Expired, renewal filed').map(it => recOf(it)).sort(byDate('renew')),
    moh: items => items.filter(it => it.g === 'moh').map(it => recOf(it, { age: it.ageMoh == null ? null : Math.round(it.ageMoh) })).sort((a, b) => (b.age == null ? -1 : b.age) - (a.age == null ? -1 : a.age)),
    dist: items => items.filter(it => it.g === 'dist').map(it => recOf(it, { age: it.ageDist == null ? null : Math.round(it.ageDist) })).sort((a, b) => (b.age == null ? -1 : b.age) - (a.age == null ? -1 : a.age)),
    queries: items => items.filter(it => it.q).map(it => recOf(it)).sort((a, b) => (a.q === 'Open query' ? 0 : a.q.startsWith('Await') ? 1 : 2) - (b.q === 'Open query' ? 0 : b.q.startsWith('Await') ? 1 : 2) || a.country.localeCompare(b.country)),
    pending: items => items.filter(it => it.pS || it.pL || it.pM || it.pA).map(it => recOf(it, { issue: [it.pS && 'Samples', it.pL && 'Legal docs', it.pM && 'MOH fees', it.pA && "Agent's fees"].filter(Boolean).join(' + ') })).sort((a, b) => a.country.localeCompare(b.country))
  };
  function actions(items) {
    const out = [];
    for (const it of items) {
      const iss = [];
      if (isExpired(it)) iss.push('Registration expired – renewal not filed');
      if (due6(it)) iss.push('Renewal due within 6 months – file now');
      if (it.g === 'moh' && it.ageMoh != null && it.ageMoh >= 12) iss.push('Under MOH > 1 year – follow up');
      if (it.tentPassed) iss.push('Tentative registration date passed');
      if (it.g === 'dist' && it.ageDist != null && it.ageDist >= 12) iss.push('With distributor > 1 year – not submitted to MOH');
      if (it.q === 'Open query') iss.push('Open query – response needed');
      if (it.q === 'Awaiting partner / client input') iss.push('Awaiting partner / client input');
      if (it.pS || it.pL) iss.push('Samples / legal documents pending');
      if (it.pM || it.pA) iss.push('MOH / agent fees pending');
      if (it.planPassed) iss.push('Plan – dossier dispatch date passed');
      for (const issue of iss) out.push(recOf(it, { issue }));
    }
    const ORD = ['Registration expired', 'Renewal due', 'Open query', 'Under MOH', 'Tentative', 'Awaiting', 'Samples', 'MOH / agent', 'With distributor', 'Plan'];
    const rank = s => { const i = ORD.findIndex(p => s.startsWith(p)); return i < 0 ? 99 : i; };
    return out.sort((a, b) => rank(a.issue) - rank(b.issue) || (a.pri === 'Priority' ? 0 : 1) - (b.pri === 'Priority' ? 0 : 1) || a.country.localeCompare(b.country));
  }
  function quality(items) {
    const t = today();
    const chk = [
      ['Approved but renewal date passed while "Registration Status" still says Valid', it => it.g === 'reg' && it.r.renew && it.r.renew < t && norm(it.r.regSt) === 'VALID' && !LIFETIME.test(it.r.freq), 'Validity flag in PRT is out of date – update to Expired or record the renewal'],
      ['Registered with no renewal / expiry date', it => (it.g === 'reg' || it.g === 'ren') && !it.r.renew && !LIFETIME.test(it.r.freq), 'Cannot be tracked for renewal'],
      ['Registered with no registration number', it => it.g === 'reg' && !it.r.regNo, 'Registration certificate details missing'],
      ['Registered without RC (registration certificate) marked available', it => it.g === 'reg' && !it.r.rc, 'Upload / tick RC availability in PRT'],
      ['Under MOH with no MOH submission date', it => it.g === 'moh' && !it.r.mohSub, 'MOH ageing cannot be measured'],
      ['Under MOH / with distributor with no tentative registration date', it => (it.g === 'moh' || it.g === 'dist') && !it.r.tent, 'Cannot be planned'],
      ['With distributor with no dossier sent date', it => it.g === 'dist' && !it.r.dsent, 'Distributor ageing cannot be measured'],
      ['Plan with no dossier dispatch plan date', it => it.g === 'plan' && !it.r.ddPlan, 'Cannot be scheduled'],
      ['Plan with "Dossier Available" blank', it => it.g === 'plan' && !it.r.dos, 'Dossier readiness unknown'],
      ['Lost (cancelled / rejected) but "Status" says Registered', it => it.g === 'lost' && /REGISTER/i.test(it.r.status2) && !/UN-?REGISTER/i.test(it.r.status2), 'Current Status and Status disagree'],
      ['Brand name left as "Generic Name"', it => /^GENERIC NAME$/i.test(it.r.brand), 'Brand not yet assigned']
    ];
    const rows = chk.map(([k0, fn, k1]) => ({ k0, n: items.filter(fn).length, k1 })).filter(r => r.n);
    return { title: 'Data quality – fix these in PRT so the regulatory view stays accurate', cols: [{ k: 'k0', l: 'Check', f: 't' }, { k: 'n', l: 'Records affected', f: 'n', hl: 1 }, { k: 'k1', l: 'Why it matters', f: 't' }], rows };
  }

  /* ---------------- dashboard ---------------- */
  // expected registration year for open registrations (pipeline)
  function pipeYear(it) {
    if (!['moh', 'dist', 'plan', 'hold'].includes(it.g)) return '';
    const t = today(), tY = +t.slice(0, 4); const d = it.r.tent || (it.g === 'plan' ? it.r.ddPlan : ''); if (!d) return 'No date';
    const y = +d.slice(0, 4); return d < t ? 'Already past' : y >= tY + 3 ? `Year ${tY + 3}+` : `Year ${y}`;
  }
  const normFreq = f => { const u = norm(f); if (!u) return '(blank)'; if (LIFETIME.test(u)) return 'Lifetime'; if (/AND/.test(u)) return f; const m = /(\d+)/.exec(u); return m ? `${+m[1]} year${+m[1] > 1 ? 's' : ''}` : f; };
  const blankAs = (v, b) => (v ? v : b || '(blank)');
  // every filter – used by the portal dashboard and the Excel dashboard
  const DIMS = [['reg', 'Region', it => it.region], ['cty', 'Country', it => it.r.country], ['cat', 'Country Cat', it => it.cat], ['grp', 'Status group', it => GLABEL[it.g]],
    ['st', 'Current Status', it => it.r.st], ['exp', 'Expiry', it => it.exp || 'Not registered'], ['qq', 'Query status', it => it.q || 'No open query'], ['pri', 'Priority', it => it.r.pri],
    ['pg', 'Product', it => prodName(it.r)], ['tc', 'Therapy (TC)', it => it.r.tc || '—'], ['mfg', 'Mfg Unit', it => it.r.mfg || '—'],
    ['ra', 'RA owner', it => it.r.raOwner || it.r.ra || '—'], ['dist', 'Distributor', it => it.r.dist || '—'], ['agent', 'Agent / consultant', it => it.r.agent || '—'], ['bdm', 'BDM', it => it.r.bdm || '—'],
    ['blk', 'Blocker', it => it.r.dcat || '(none)'], ['age', 'Ageing', it => (it.g === 'moh' ? 'MOH ' + ageBand(it.ageMoh) : it.g === 'dist' ? 'Distributor ' + ageBand(it.ageDist) : '—')],
    ['yr', 'Expected reg. year', it => pipeYear(it) || '—'], ['freq', 'Renewal frequency', it => normFreq(it.r.freq)], ['rc', 'RC available', it => (it.r.rc ? 'Yes' : 'No')],
    ['dos', 'Dossier available', it => blankAs(it.r.dos)], ['dtype', 'Dossier type', it => blankAs(it.r.dtype)], ['rtype', 'Registration type', it => blankAs(it.r.regType)],
    ['samp', 'Samples', it => (it.pS ? 'Pending' : blankAs(it.r.samples && /NOT REQUIR|^NA$/i.test(it.r.samples) ? 'Not required' : it.r.samples ? 'Sent / other' : ''))],
    ['legal', 'Legal docs', it => (it.pL ? 'Pending' : blankAs(it.r.legal && /NOT REQUIR|^NA$/i.test(it.r.legal) ? 'Not required' : it.r.legal ? 'Sent / other' : ''))],
    ['mfee', 'MOH fees', it => blankAs(it.r.mohFee)], ['afee', "Agent's fees", it => blankAs(it.r.agFee)]];
  // the 6 filters shown on the dashboard (region users get Query status instead of Region)
  const multiRegion = scope => scope.admin || scope.regions.length > 1;
  const filterDims = scope => (multiRegion(scope) ? ['reg', 'cty', 'pg', 'grp', 'exp', 'ra'] : ['cty', 'pg', 'grp', 'exp', 'ra', 'qq']).map(k => DIMS.find(d => d[0] === k));
  function filtered(ds, settings, scope, filters) {
    const base = scopeRows(ds, scope, settings);
    const dims = filterDims(scope);
    const sel = {}; for (const d of dims) { const v = (filters || {})[d[0]]; if (Array.isArray(v) && v.length) sel[d[0]] = new Set(v.map(String)); }
    const vals = base.map(it => dims.map(d => String(d[2](it))));
    const pass = (i, skip) => dims.every((d, j) => j === skip || !sel[d[0]] || sel[d[0]].has(vals[i][j]));
    return { base, dims, sel, vals, pass, items: base.filter((_, i) => pass(i, -1)) };
  }
  const FIXED = { grp: GORDER.map(g => GLABEL[g]), exp: [...EXP, 'Not registered'], qq: ['Open query', 'Awaiting partner / client input', 'Responded – awaiting MOH / partner', 'No open query'],
    age: [...AGE.map(a => 'MOH ' + a), ...AGE.map(a => 'Distributor ' + a), '—'] };
  const sortOpts = (key, m) => { let o = [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([v]) => v);
    if (FIXED[key]) o = FIXED[key].filter(x => m.has(x)); else if (key === 'yr') o = o.sort((a, b) => (a === '—' ? 2 : a === 'No date' ? 1 : 0) - (b === '—' ? 2 : b === 'No date' ? 1 : 0) || (a === 'Already past' ? -1 : b === 'Already past' ? 1 : a.localeCompare(b)));
    return o; };
  function dashboard(ds, settings, scope, filters) {
    const F = filtered(ds, settings, scope, filters); const items = F.items;
    const options = F.dims.map((d, j) => {
      const m = new Map();
      for (let i = 0; i < F.base.length; i++) { if (!F.pass(i, j)) continue; const v = F.vals[i][j]; m.set(v, (m.get(v) || 0) + 1); }
      const opts = sortOpts(d[0], m);
      return { k: d[0], l: d[1], opts, sel: F.sel[d[0]] ? [...F.sel[d[0]]] : [] };
    });
    const T = group(items, () => ['T'], true).total;
    const nq = k => items.filter(it => it.q === k).length;
    const mohOld = items.filter(it => it.g === 'moh' && it.ageMoh != null && it.ageMoh >= 12).length;
    const distOld = items.filter(it => it.g === 'dist' && it.ageDist != null && it.ageDist >= 12).length;
    const cnt = f => items.filter(f).length;
    const mohAges = items.filter(it => it.g === 'moh' && it.ageMoh != null).map(it => it.ageMoh).sort((a, b) => a - b);
    const med = mohAges.length ? Math.round(mohAges[Math.floor(mohAges.length / 2)]) : 0;
    const cards = [
      { l: 'Registered (valid)', v: T.valid + T.ren - T.renF, f: 'n', s: `${T.cReg} countries · ${new Set(items.filter(it => (it.g === 'reg' || it.g === 'ren') && !isExpired(it)).map(it => it.r.gen)).size} SKUs` },
      { l: 'Registration expired – renewal not filed', v: T.exp, f: 'n', s: `Renewal filed after expiry: ${T.renF}` },
      { l: 'Renewals due in next 6 months', v: T.d6, f: 'n', s: `Due 6–12 months: ${T.d12}` },
      { l: 'Under MOH review', v: T.moh, f: 'n', s: `> 1 year at MOH: ${mohOld} · median ${med} months` },
      { l: 'Dossier with distributor / agent', v: T.dist, f: 'n', s: `> 1 year not submitted: ${distOld}` },
      { l: 'Open queries (MOH / partner)', v: nq('Open query'), f: 'n', s: `Awaiting partner input ${nq('Awaiting partner / client input')} · responded ${nq('Responded – awaiting MOH / partner')}` },
      { l: 'Pending samples / legal documents', v: cnt(it => it.pS || it.pL), f: 'n', s: `Samples ${cnt(it => it.pS)} · Legal docs ${cnt(it => it.pL)}` },
      { l: 'Pending MOH / agent fees', v: cnt(it => it.pM || it.pA), f: 'n', s: `MOH fees ${cnt(it => it.pM)} · Agent's fees ${cnt(it => it.pA)}` },
      { l: 'Plan – not started', v: T.plan, f: 'n', s: `Dispatch date already passed: ${cnt(it => it.planPassed)}` },
      { l: 'On hold / lost', v: T.hold + T.lost, f: 'n', s: `On hold ${T.hold} · Lost ${T.lost}` },
      { l: 'Records tracked', v: T.n, f: 'n', s: `${T.cAll} countries · ${new Set(items.map(x => x.r.gen)).size} SKUs` },
      { l: 'Registered % of active', v: T.regPct, f: 'p', s: `Active = all except lost (${T.act})` }
    ];
    const stTbl = (() => { const rows = GORDER.map(g => { const its = items.filter(it => it.g === g); return { k0: GLABEL[g], n: its.length, c: new Set(its.map(it => norm(it.r.country))).size, p: new Set(its.map(it => it.r.gen)).size, pr: its.filter(it => it.r.pri === 'Priority').length }; }).filter(r => r.n);
      return { title: 'Registration status summary', cols: [{ k: 'k0', l: 'Status group', f: 't' }, { k: 'n', l: 'Registrations', f: 'n', hl: 1 }, { k: 'c', l: 'Countries', f: 'n' }, { k: 'p', l: 'SKUs', f: 'n' }, { k: 'pr', l: 'Priority', f: 'n' }], rows, total: { k0: 'TOTAL', n: items.length, c: T.cAll, p: new Set(items.map(x => x.r.gen)).size, pr: cnt(it => it.r.pri === 'Priority') } }; })();
    const regd = items.filter(it => it.g === 'reg' || it.g === 'ren');
    const L = ['country', 'gen', 'st', 'regNo', 'renew', 'exp', 'dist', 'ra'];
    const sections = [
      stTbl,
      buckets('Registered products – expiry / renewal status', EXP, regd, it => it.exp, 'Registered = Approved + Under renewal. "Expired, not filed" = renewal date passed and status still Approved.'),
      renewCalendar(items),
      list('Expired registrations – renewal not filed', L, sets.expired(items), 40, 'see the Expired view'),
      list('Renewals due in the next 12 months', L, sets.due(items), 40, 'see the Renewals view'),
      tbl('Region-wise regulatory status', ['Region'], group(items, it => [it.region], true), 0, '', true),
      tbl('Country-wise regulatory status', ['Country', 'Region', 'Cat'], group(items, it => [it.r.country, it.region, it.cat]), 40, 'see the Country view for all'),
      buckets('Under MOH – time since MOH submission', AGE, items.filter(it => it.g === 'moh'), it => ageBand(it.ageMoh)),
      buckets('With distributor / agent – time since dossier sent', AGE, items.filter(it => it.g === 'dist'), it => ageBand(it.ageDist)),
      list('Open queries & partner inputs awaited', ['country', 'gen', 'st', 'q', 'remarks', 'comm', 'ra'], sets.queries(items).filter(r => r.q !== 'Responded – awaiting MOH / partner'), 40, 'see the Queries view'),
      (() => { const g = group(items.filter(it => it.pS || it.pL || it.pM || it.pA), it => [it.r.country, it.region]); const rows = g.rows.map(r => r);
        const cntBy = (k, f) => { const m = new Map(); items.forEach(it => { if (f(it)) { const kk = norm(it.r.country); m.set(kk, (m.get(kk) || 0) + 1); } }); return m; };
        const S = cntBy('s', it => it.pS), Lg = cntBy('l', it => it.pL), M = cntBy('m', it => it.pM), A = cntBy('a', it => it.pA);
        rows.forEach(r => { const k = norm(r.k0); r.s = S.get(k) || 0; r.l = Lg.get(k) || 0; r.m = M.get(k) || 0; r.a = A.get(k) || 0; });
        rows.sort((a, b) => b.pend - a.pend);
        return { title: 'Pending samples, legal documents & fees – by country', cols: [{ k: 'k0', l: 'Country', f: 't' }, { k: 'k1', l: 'Region', f: 't' }, { k: 'pend', l: 'Records with something pending', f: 'n', hl: 1 }, { k: 's', l: 'Samples', f: 'n' }, { k: 'l', l: 'Legal docs', f: 'n' }, { k: 'm', l: 'MOH fees', f: 'n' }, { k: 'a', l: "Agent's fees", f: 'n' }],
          rows, total: { k0: 'TOTAL', pend: g.total.pend, s: cnt(it => it.pS), l: cnt(it => it.pL), m: cnt(it => it.pM), a: cnt(it => it.pA) } }; })(),
      (() => { const g = group(items.filter(x => ['moh', 'dist', 'plan', 'hold'].includes(x.g)), it => [it.r.dcat || '(no reason given)']); return { title: 'Blockers / delay reasons (open registrations)', cols: [{ k: 'k0', l: 'Reason', f: 't' }, { k: 'n', l: 'Registrations', f: 'n', hl: 1 }, { k: 'moh', l: 'Under MOH', f: 'n' }, { k: 'dist', l: 'With distributor', f: 'n' }, { k: 'plan', l: 'Plan', f: 'n' }, { k: 'hold', l: 'On hold', f: 'n' }], rows: g.rows.sort((a, b) => (a.k0[0] === '(' ? 1 : 0) - (b.k0[0] === '(' ? 1 : 0) || b.n - a.n), total: g.total }; })(),
      tbl('Product-wise registrations', ['Product', 'Therapy'], group(items, it => [prodName(it.r), it.r.tc || '—'], true), 30, 'see the Product view for all', true),
      tbl('RA owner-wise workload', ['RA owner'], group(items, it => [it.r.raOwner || it.r.ra || '—'])),
      (() => { const act = items.filter(it => ['moh', 'dist', 'plan', 'hold'].includes(it.g)); const tY = +today().slice(0, 4);
        const yr = pipeYear;
        const labels = ['Already past', `Year ${tY}`, `Year ${tY + 1}`, `Year ${tY + 2}`, `Year ${tY + 3}+`, 'No date'];
        const rows = labels.map(l => { const its = act.filter(it => yr(it) === l); return { k0: l, moh: its.filter(x => x.g === 'moh').length, dist: its.filter(x => x.g === 'dist').length, plan: its.filter(x => x.g === 'plan').length, hold: its.filter(x => x.g === 'hold').length, n: its.length }; });
        const total = { k0: 'TOTAL' };['moh', 'dist', 'plan', 'hold', 'n'].forEach(k => { total[k] = rows.reduce((a, r) => a + r[k], 0); });
        return { title: 'Registration pipeline by tentative registration year', cols: [{ k: 'k0', l: 'Expected year', f: 't' }, { k: 'moh', l: 'Under MOH', f: 'n' }, { k: 'dist', l: 'With distributor', f: 'n' }, { k: 'plan', l: 'Plan', f: 'n' }, { k: 'hold', l: 'On hold', f: 'n' }, { k: 'n', l: 'Total', f: 'n', hl: 1 }], rows, total,
          note: 'Uses Tentative Reg. Expected Date (Plan falls back to dossier dispatch plan date).' }; })(),
      (() => { const act = items.filter(it => ['moh', 'dist', 'plan', 'hold'].includes(it.g)); const rows = [
        ['Dossier available – Yes', it => /^YES/i.test(it.r.dos)], ['Dossier available – No', it => /^NO/i.test(it.r.dos)], ['Dossier available – blank', it => !it.r.dos],
        ['Dossier type – CTD', it => norm(it.r.dtype) === 'CTD'], ['Dossier type – eCTD', it => norm(it.r.dtype) === 'ECTD'], ['Dossier type – Non-CTD', it => norm(it.r.dtype) === 'NON-CTD']].map(([k0, f]) => ({ k0, n: act.filter(f).length, moh: act.filter(it => it.g === 'moh' && f(it)).length, dist: act.filter(it => it.g === 'dist' && f(it)).length, plan: act.filter(it => it.g === 'plan' && f(it)).length }));
        return { title: 'Dossier readiness (open registrations)', cols: [{ k: 'k0', l: 'Dossier', f: 't' }, { k: 'n', l: 'Registrations', f: 'n', hl: 1 }, { k: 'moh', l: 'Under MOH', f: 'n' }, { k: 'dist', l: 'With distributor', f: 'n' }, { k: 'plan', l: 'Plan', f: 'n' }], rows }; })()
    ];
    return { dashboard: true, title: 'PRT regulatory dashboard', unit: `Counts of registrations (country × SKU) · ageing & expiry as of ${fmtD(today())}`, count: T.n, options, cards, sections };
  }
  const fmtD = s => (s ? `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}` : '');

  /* ---------------- views ---------------- */
  const VIEWS = [['dashboard', 'Dashboard'], ['actions', 'Action list'], ['renewals', 'Renewals due'], ['expired', 'Expired'], ['moh', 'Under MOH'], ['distributor', 'With distributor'],
    ['queries', 'Queries'], ['pending', 'Pending docs & fees'], ['country', 'Country'], ['product', 'Product'], ['generic', 'SKU'], ['region', 'Region'], ['ra', 'RA owner'], ['partner', 'Distributor / agent'],
    ['delay', 'Blockers'], ['matrix', 'Matrix'], ['list', 'Full list'], ['quality', 'Data quality']];
  const CODE = { reg: 'R', ren: 'U', moh: 'M', dist: 'A', plan: 'P', hold: 'H', lost: 'X', oth: '·' };
  const RANK = { E: 7, R: 8, U: 7.5, M: 5, A: 4, P: 3, H: 2, X: 1, '·': 0 };
  function compute(data, settings, scope, view, opt) {
    const ds = data && data.PRT; if (!ds) return { empty: true };
    opt = opt || {};
    if (view === 'dashboard') return dashboard(ds, settings, scope, opt.filters);
    const items = filtered(ds, settings, scope, opt.filters).items;
    const unit = `Counts of registrations · as of ${fmtD(today())}`;
    const lim = opt.all ? 0 : 500;
    const search = rows => { const q = String(opt.q || '').toLowerCase(); return q ? rows.filter(o => Object.values(o).some(v => typeof v === 'string' && v.toLowerCase().includes(q))) : rows; };
    const L = (title, keys, rows, note) => ({ ...list(title, keys, search(rows), lim, note || 'type in Search to narrow, or download Excel for the full list'), unit, serverSearch: true });
    switch (view) {
      case 'actions': return L('Action list – regulatory follow-ups', ['issue', 'country', 'region', 'gen', 'st', 'pri', 'renew', 'mohSub', 'tent', 'dist', 'ra', 'dcat', 'comm'], actions(items));
      case 'renewals': { const t = L('Renewals due in the next 12 months', ['country', 'region', 'gen', 'brand', 'regNo', 'reg', 'renew', 'exp', 'freq', 'st', 'dist', 'agent', 'ra'], sets.due(items));
        t.extra = list('Renewal filed after expiry (Under renewal, date passed)', ['country', 'region', 'gen', 'regNo', 'renew', 'st', 'dist', 'ra', 'comm'], sets.renFiled(items)); t.pre = renewCalendar(items); return t; }
      case 'expired': return L('Expired registrations – renewal not filed', ['country', 'region', 'gen', 'brand', 'regNo', 'reg', 'renew', 'freq', 'dist', 'agent', 'ra', 'comm'], sets.expired(items), 'expired = renewal date passed and status still Approved');
      case 'moh': return L('Under MOH review – oldest first', ['country', 'region', 'gen', 'mohSub', 'age', 'tent', 'dcat', 'q', 'dist', 'agent', 'ra', 'comm'], sets.moh(items), '"Months" = months since MOH submission');
      case 'distributor': return L('Dossier with distributor / agent – oldest first', ['country', 'region', 'gen', 'dsent', 'age', 'planMoh', 'tent', 'dcat', 'samples', 'legal', 'dist', 'agent', 'ra', 'comm'], sets.dist(items), '"Months" = months since dossier sent');
      case 'queries': return L('Queries from MOH / partners', ['q', 'country', 'region', 'gen', 'st', 'remarks', 'comm', 'dist', 'agent', 'ra'], sets.queries(items), 'read from the latest PRT comment and Regulatory Remarks');
      case 'pending': return L('Pending samples, legal documents & fees', ['issue', 'country', 'region', 'gen', 'st', 'samples', 'legal', 'mohFee', 'agFee', 'dist', 'agent', 'ra'], sets.pending(items));
      case 'country': return { ...tbl('Country-wise regulatory status', ['Country', 'Region', 'Cat'], group(items, it => [it.r.country, it.region, it.cat])), unit };
      case 'product': return { ...tbl('Product-wise registrations', ['Product', 'Therapy', 'Mfg unit'], group(items, it => [prodName(it.r), it.r.tc || '—', it.r.mfg || '—'], true), 0, '', true), unit };
      case 'generic': return { ...tbl('SKU-wise registrations', ['SKU (generic name)', 'Product'], group(items, it => [it.r.gen, prodName(it.r)], true), 0, '', true), unit };
      case 'region': return { ...tbl('Region-wise regulatory status', ['Region'], group(items, it => [it.region], true), 0, '', true), unit };
      case 'ra': return { ...tbl('RA owner-wise workload', ['RA owner'], group(items, it => [it.r.raOwner || it.r.ra || '—'])), unit };
      case 'partner': return { ...tbl('Distributor / agent-wise status', ['Distributor', 'Country'], group(items, it => [it.r.dist || '—', it.r.country])), unit };
      case 'delay': { const g = group(items.filter(x => ['moh', 'dist', 'plan', 'hold'].includes(x.g)), it => [it.r.dcat || '(no reason given)', it.r.country]); return { title: 'Blockers / delay reasons by country (open registrations)', unit, cols: [{ k: 'k0', l: 'Reason', f: 't' }, { k: 'k1', l: 'Country', f: 't' }, { k: 'n', l: 'Registrations', f: 'n', hl: 1 }, { k: 'moh', l: 'Under MOH', f: 'n' }, { k: 'dist', l: 'With distributor', f: 'n' }, { k: 'plan', l: 'Plan', f: 'n' }, { k: 'hold', l: 'On hold', f: 'n' }], rows: g.rows.sort((a, b) => a.k0.localeCompare(b.k0) || b.n - a.n), total: g.total }; }
      case 'quality': return { ...quality(items), unit };
      case 'matrix': {
        const cell = new Map(), pc = new Map(), cn = new Map();
        for (const it of items) {
          const p = prodName(it.r) === '—' ? it.r.gen : prodName(it.r); const k = p + '\u0001' + norm(it.r.country);
          const code = isExpired(it) ? 'E' : CODE[it.g]; const c = cell.get(k);
          if (!c || RANK[code] > RANK[c]) cell.set(k, code);
          pc.set(p, (pc.get(p) || 0) + 1); cn.set(norm(it.r.country), [it.r.country, ((cn.get(norm(it.r.country)) || [0, 0])[1]) + 1]);
        }
        const prods = [...pc.entries()].sort((a, b) => b[1] - a[1]).slice(0, opt.all ? 400 : 80).map(x => x[0]);
        const ctys = [...cn.entries()].sort((a, b) => b[1][1] - a[1][1]).slice(0, 70).map(x => [x[0], x[1][0]]);
        const rows = prods.map(p => { const o = { k0: p }; ctys.forEach(([ck], i) => { o['c' + i] = cell.get(p + '\u0001' + ck) || ''; }); o.nreg = ctys.filter((c, i) => o['c' + i] === 'R' || o['c' + i] === 'U').length; o.nexp = ctys.filter((c, i) => o['c' + i] === 'E').length; return o; });
        return { title: 'Registration matrix – product × country', unit, matrix: true, cols: [{ k: 'k0', l: 'Product', f: 't' }, { k: 'nreg', l: 'Countries registered', f: 'n', hl: 1 }, { k: 'nexp', l: 'Expired', f: 'n' }, ...ctys.map(([, c], i) => ({ k: 'c' + i, l: c, f: 'c' }))], rows,
          note: 'R = Registered · E = Expired, not filed · U = Under renewal · M = Under MOH · A = With distributor / agent · P = Plan · H = On hold · X = Lost · blank = not in PRT. Best status per product (any SKU) shown.' };
      }
      case 'list': return L('Full registration list', ['country', 'region', 'gen', 'pg', 'brand', 'st', 'exp', 'regNo', 'reg', 'renew', 'mohSub', 'tent', 'dist', 'agent', 'ra', 'dcat', 'q', 'comm', 'id'], items.map(it => recOf(it)).sort((a, b) => a.country.localeCompare(b.country) || a.gen.localeCompare(b.gen)));
    }
    return { empty: true };
  }

  /* ---------------- Excel ---------------- */
  const colL = n => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }; // 0 -> A
  const xq = v => '"' + String(v).replace(/"/g, '""') + '"';
  async function toXlsx(ExcelJS, data, settings, scope, label, opt) {
    const wb = new ExcelJS.Workbook(); wb.creator = 'Aculife-IB Portal'; wb.calcProperties.fullCalcOnLoad = true;
    const NAVY = 'FF0B2A4A', YEL = 'FFFFF2B3';
    const fmt = f => (f === 'p' ? '0.0%' : f === 'n' ? '#,##0' : f === 'd' ? 'dd-mmm-yyyy' : '@');
    const hdr = r => r.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { wrapText: true, vertical: 'middle' }; });
    const MX = { R: 'FFD5F5E3', E: 'FFF5B7B1', U: 'FFD6EAF8', M: 'FFE8F1FB', A: 'FFFFF4E0', P: 'FFEEF0F3', H: 'FFFDEEE0', X: 'FFFBE9E7' };
    const val = (c, v) => { if (v === null || v === undefined) return ''; if (c.f === 'd' && v) { const d = new Date(v + 'T00:00:00Z'); return isNaN(d) ? v : d; } return v; };
    const writeTable = (ws, t) => {
      hdr(ws.addRow(t.cols.map(c => c.l)));
      const put = (o, bold) => { const r = ws.addRow(t.cols.map(c => val(c, o[c.k])));
        t.cols.forEach((c, i) => { const cell = r.getCell(i + 1); if (typeof cell.value === 'number' || cell.value instanceof Date) cell.numFmt = fmt(c.f);
          if (c.f === 'c' && MX[cell.value]) { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MX[cell.value] } }; cell.alignment = { horizontal: 'center' }; } });
        if (bold) r.eachCell(c => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F6' } }; }); };
      if (t.total) put(t.total, true); t.rows.forEach(o => put(o));
      if (t.note) ws.addRow([t.note]).font = { italic: true, color: { argb: 'FF888888' } };
    };
    const sheet = (name, t) => {
      const ws = wb.addWorksheet(name.slice(0, 31));
      ws.addRow([t.title + (label ? ' – ' + label : '')]).font = { bold: true, size: 13, color: { argb: NAVY } };
      ws.addRow([t.unit || '']).font = { italic: true, color: { argb: 'FF666666' } }; ws.addRow([]);
      if (t.pre) { ws.addRow([t.pre.title]).font = { bold: true, color: { argb: NAVY } }; writeTable(ws, t.pre); ws.addRow([]); }
      const startRow = ws.rowCount + 1;
      writeTable(ws, t);
      t.cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.f === 't' || c.f === 's2' ? 24 : c.f === 'tl' ? 60 : c.f === 'c' ? 6 : c.f === 'd' ? 13 : 12; });
      if (!t.pre) ws.views = [{ state: 'frozen', ySplit: startRow, xSplit: 1 }];
      if (!t.matrix && t.rows.length > 1) ws.autoFilter = { from: { row: startRow, column: 1 }, to: { row: startRow, column: t.cols.length } };
      return ws;
    };
    if (!data || !data.PRT) { wb.addWorksheet('No data').addRow(['No PRT data uploaded yet.']); return wb; }
    opt = opt || {};
    const F = filtered(data.PRT, settings, scope, opt.filters); const items = F.items; const fdims = F.dims; const dims = DIMS.filter(d => d[0] !== 'reg' || multiRegion(scope));
    const t0 = today();
    /* ----- Data sheet layout: filter columns, info columns, flag columns, Inc ----- */
    const info = [['SKU (generic name)', it => it.r.gen, 36], ['Brand', it => it.r.brand, 18], ['Registration no.', it => it.r.regNo, 16], ['Registration date', it => it.r.reg, 12, 'd'],
      ['Renewal / expiry date', it => it.r.renew, 12, 'd'], ['MOH submission', it => it.r.mohSub, 12, 'd'], ['Months at MOH', it => (it.ageMoh == null ? '' : Math.round(it.ageMoh)), 9],
      ['Dossier sent', it => it.r.dsent, 12, 'd'], ['Months with distributor', it => (it.ageDist == null ? '' : Math.round(it.ageDist)), 9], ['Tentative reg. date', it => it.r.tent, 12, 'd'],
      ['Dossier dispatch plan', it => it.r.ddPlan, 12, 'd'], ['Regulatory remark', it => it.r.remarks, 30], ['Latest comment', it => it.r.comm, 60], ['PRT ID', it => it.r.id, 9]];
    const reg = it => it.g === 'reg' || it.g === 'ren';
    const flags = [['fValid', it => reg(it) && it.exp !== 'Expired, not filed' && it.exp !== 'Expired, renewal filed'], ['fExp', isExpired], ['fRenF', it => it.exp === 'Expired, renewal filed'],
      ['fD6', due6], ['fD612', it => it.exp === 'Due 6–12 months'], ['fMoh1', it => it.g === 'moh' && it.ageMoh != null && it.ageMoh >= 12], ['fDist1', it => it.g === 'dist' && it.ageDist != null && it.ageDist >= 12],
      ['fOQ', it => it.q === 'Open query'], ['fAQ', it => it.q === 'Awaiting partner / client input'], ['fRQ', it => it.q === 'Responded – awaiting MOH / partner'],
      ['fPS', it => it.pS], ['fPL', it => it.pL], ['fPM', it => it.pM], ['fPA', it => it.pA], ['fPend', it => it.pS || it.pL || it.pM || it.pA], ['fPSL', it => it.pS || it.pL], ['fPMA', it => it.pM || it.pA], ['fPlanP', it => it.planPassed], ['fTentP', it => it.tentPassed],
      ['fPri', it => it.r.pri === 'Priority'], ['fAct', it => ACTIVE(it.g)], ['fOpen', it => ['moh', 'dist', 'plan', 'hold'].includes(it.g)],
      ['fRenM', it => (reg(it) && it.exp !== 'Lifetime' && it.r.renew && it.r.renew >= t0 ? 'M' + it.r.renew.slice(0, 7) : '')]];
    const nD = dims.length, nI = info.length; const fCol = {}; flags.forEach((f, i) => { fCol[f[0]] = colL(nD + nI + i); });
    const N = items.length, last = N + 1;
    const rng = c => `Data!$${c}$2:$${c}$${last}`;
    const dCol = {}; dims.forEach((d, i) => { dCol[d[0]] = colL(i); });
    // JS mirror of the data for cached results (all filters = All)
    const R = items.map(it => { const o = {}; dims.forEach(d => { o[d[0]] = String(d[2](it)); }); flags.forEach(f => { const v = f[1](it); o[f[0]] = f[0] === 'fRenM' ? v : v ? 1 : 0; }); return o; });
    // formula builders: crit = [[dimKey or flagKey, expr, value]]
    const critF = crit => crit.map(([k, e]) => `,${rng(dCol[k] || fCol[k])},${e}`).join('');
    const critJ = crit => o => crit.every(([k, , v]) => String(o[k]) === String(v));
    const CNT = (crit, flag) => { const m = critJ(crit); let r = 0; for (const o of R) if (m(o)) r += flag ? o[flag] : 1;
      const fc = fdims.map(d => `,${rng(dCol[d[0]])},IF(${fCell[d[0]]}="All","*","="&${fCell[d[0]]})`).join('');
      return { formula: flag ? `SUMIFS(${rng(fCol[flag])}${fc}${critF(crit)})` : `COUNTIFS(${fc.slice(1)}${critF(crit)})`, result: r }; };
    /* ----- Lists sheet (drop-down values) ----- */
    const opts = dims.map(d => { const m = new Map(); R.forEach(o => m.set(o[d[0]], (m.get(o[d[0]]) || 0) + 1)); return sortOpts(d[0], m); });
    /* ----- Dashboard ----- */
    const ws = wb.addWorksheet('Dashboard', { views: [{ showGridLines: false }] });
    ws.addRow(['Aculife-IB – PRT regulatory dashboard' + (label ? ' – ' + label : '')]).font = { bold: true, size: 15, color: { argb: NAVY } };
    ws.addRow([`Counts of registrations (country × SKU) · expiry & ageing as of ${fmtD(t0)}` + (Object.values(opt.filters || {}).some(v => v && v.length) ? ' · portal filters applied before download' : '')]).font = { italic: true, color: { argb: 'FF666666' } };
    ws.addRow(['FILTERS – click a yellow cell and pick from the drop-down ("All" = no filter). All numbers below update. Open in desktop Excel and click "Enable Editing" if a yellow bar shows.']).font = { bold: true, color: { argb: 'FF8A5A00' } };
    const fStart = 4, perCol = Math.ceil(fdims.length / 3); const fCell = {};
    fdims.forEach((d, i) => { const oi = dims.indexOf(d); const blk = Math.floor(i / perCol), r = fStart + (i % perCol), lc = 1 + blk * 3, vc = lc + 1;
      const lcell = ws.getCell(r, lc); lcell.value = d[1]; lcell.font = { bold: true }; lcell.alignment = { horizontal: 'right' };
      const c = ws.getCell(r, vc); c.value = 'All'; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL } }; c.border = { top: { style: 'thin', color: { argb: 'FFD4B000' } }, bottom: { style: 'thin', color: { argb: 'FFD4B000' } }, left: { style: 'thin', color: { argb: 'FFD4B000' } }, right: { style: 'thin', color: { argb: 'FFD4B000' } } };
      c.dataValidation = { type: 'list', allowBlank: false, showErrorMessage: true, errorTitle: 'Pick from the list', error: 'Choose a value from the drop-down, or All.', formulae: [`Lists!$${colL(i)}$1:$${colL(i)}$${opts[oi].length + 1}`] };
      fCell[d[0]] = `Dashboard!$${colL(vc - 1)}$${r}`; });
    let row = fStart + perCol + 1;
    const selCnt = { formula: fdims.map(d => `(${fCell[d[0]]}<>"All")`).join('+'), result: 0 };
    ws.getCell(row, 1).value = 'Filters in use'; ws.getCell(row, 1).font = { bold: true }; ws.getCell(row, 2).value = selCnt; ws.getCell(row, 3).value = 'Records in selection'; ws.getCell(row, 3).font = { bold: true };
    ws.getCell(row, 4).value = CNT([]); ws.getCell(row, 4).font = { bold: true, color: { argb: NAVY } };
    row += 2;
    const title = t => { ws.getCell(row, 1).value = t; ws.getCell(row, 1).font = { bold: true, size: 12, color: { argb: NAVY } }; row++; };
    const headRow = labels => { labels.forEach((l, i) => { const c = ws.getCell(row, i + 1); c.value = l; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { wrapText: true, vertical: 'middle' }; }); ws.getRow(row).height = 30; row++; };
    // headline
    title('Headline');
    const card = (l, v, sub) => { ws.getCell(row, 1).value = l; const c = ws.getCell(row, 2); c.value = v; c.numFmt = '#,##0'; c.font = { bold: true, size: 12, color: { argb: NAVY } };
      if (sub) { ws.getCell(row, 3).value = sub; ws.getCell(row, 3).font = { color: { argb: 'FF666666' } }; } row++; };
    const subF = parts => { let res = ''; const f = parts.map(p => { if (typeof p === 'string') { res += p; return xq(p); } res += String(p.result); return `TEXT(${p.formula},"#,##0")`; }).join('&'); return { formula: f, result: res }; };
    card('Registered (valid)', CNT([], 'fValid'), subF(['Registered or under renewal, renewal date not passed']));
    card('Registration expired – renewal not filed', CNT([], 'fExp'), subF(['Renewal filed after expiry: ', CNT([], 'fRenF')]));
    card('Renewals due in next 6 months', CNT([], 'fD6'), subF(['Due in 6–12 months: ', CNT([], 'fD612')]));
    card('Under MOH review', CNT([['grp', xq('=' + GLABEL.moh), GLABEL.moh]]), subF(['More than 1 year at MOH: ', CNT([], 'fMoh1'), ' · tentative date passed: ', CNT([], 'fTentP')]));
    card('Dossier with distributor / agent', CNT([['grp', xq('=' + GLABEL.dist), GLABEL.dist]]), subF(['Sent > 1 year ago, not yet at MOH: ', CNT([], 'fDist1')]));
    card('Open queries (MOH / partner)', CNT([], 'fOQ'), subF(['Awaiting partner input: ', CNT([], 'fAQ'), ' · responded, awaiting MOH: ', CNT([], 'fRQ')]));
    card('Pending samples / legal documents', CNT([], 'fPSL'), subF(['Samples: ', CNT([], 'fPS'), ' · Legal docs: ', CNT([], 'fPL')]));
    card('Pending MOH / agent fees', CNT([], 'fPMA'), subF(['MOH fees: ', CNT([], 'fPM'), " · Agent's fees: ", CNT([], 'fPA')]));
    card('Plan – not started', CNT([['grp', xq('=' + GLABEL.plan), GLABEL.plan]]), subF(['Dossier dispatch date already passed: ', CNT([], 'fPlanP')]));
    card('On hold / lost', { formula: `${CNT([['grp', xq('=' + GLABEL.hold), GLABEL.hold]]).formula}+${CNT([['grp', xq('=' + GLABEL.lost), GLABEL.lost]]).formula}`, result: R.filter(o => o.grp === GLABEL.hold || o.grp === GLABEL.lost).length });
    card('Priority registrations', CNT([], 'fPri'));
    const pc = ws.getCell(row, 1); pc.value = 'Registered % of active'; const pv = ws.getCell(row, 2);
    const act = R.filter(o => o.fAct).length; pv.value = { formula: `IFERROR((${CNT([['grp', xq('=' + GLABEL.reg), GLABEL.reg]]).formula}+${CNT([['grp', xq('=' + GLABEL.ren), GLABEL.ren]]).formula})/${CNT([], 'fAct').formula},0)`, result: act ? R.filter(o => o.grp === GLABEL.reg || o.grp === GLABEL.ren).length / act : 0 };
    pv.numFmt = '0.0%'; pv.font = { bold: true, size: 12, color: { argb: NAVY } }; ws.getCell(row, 3).value = 'Active = everything except lost'; row += 2;
    // generic table: rows = labels of a dim (or fixed list), cols = [{l, crit:(label)=>[[k,expr,v]], flag}]
    const table = (t, dimKey, labels, cols, opts2) => {
      title(t); const top = row; headRow([(opts2 && opts2.head) || (dims.find(d => d[0] === dimKey) || [0, ''])[1], ...cols.map(c => c.l)]);
      const totRow = row; ws.getCell(row, 1).value = 'TOTAL'; row++;
      const first = row;
      labels.forEach(lab => { ws.getCell(row, 1).value = lab;
        cols.forEach((c, i) => { const crit = [...(dimKey ? [[dimKey, `"="&$A${row}`, lab]] : []), ...(c.crit || [])]; const x = CNT(crit, c.flag); const cell = ws.getCell(row, i + 2); cell.value = x; cell.numFmt = '#,##0'; if (c.hl) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF6F4' } }; });
        row++; });
      cols.forEach((c, i) => { const L = colL(i + 1); const cell = ws.getCell(totRow, i + 2); let r = 0; for (let k = first; k < row; k++) r += ws.getCell(k, i + 2).value.result || 0;
        cell.value = { formula: `SUM(${L}${first}:${L}${row - 1})`, result: r }; cell.numFmt = '#,##0'; });
      ws.getRow(totRow).eachCell(c => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F6' } }; });
      if (opts2 && opts2.note) { ws.getCell(row, 1).value = opts2.note; ws.getCell(row, 1).font = { italic: true, color: { argb: 'FF888888' } }; row++; }
      row++; return top;
    };
    const G = g => ['grp', xq('=' + GLABEL[g]), GLABEL[g]];
    const valsOf = k => opts[dims.findIndex(d => d[0] === k)] || [];
    const statusCols = [{ l: 'Active', flag: 'fAct', hl: 1 }, { l: 'Registered', crit: [G('reg')] }, { l: 'Under renewal', crit: [G('ren')] }, { l: 'Under MOH', crit: [G('moh')] },
      { l: 'With distributor', crit: [G('dist')] }, { l: 'Plan', crit: [G('plan')] }, { l: 'On hold', crit: [G('hold')] }, { l: 'Lost', crit: [G('lost')] },
      { l: 'Expired, not filed', flag: 'fExp', hl: 1 }, { l: 'Renewal due ≤ 6 m', flag: 'fD6' }, { l: 'Renewal due 6–12 m', flag: 'fD612' }, { l: 'MOH > 1 year', flag: 'fMoh1' },
      { l: 'Open queries', flag: 'fOQ' }, { l: 'Pending docs / fees', flag: 'fPend' }];
    table('1. Registration status summary', 'grp', valsOf('grp'), [{ l: 'Registrations', hl: 1 }, { l: 'Priority', flag: 'fPri' }]);
    table('2. Registered products – expiry / renewal status', 'exp', EXP, [{ l: 'Registrations', hl: 1 }, { l: 'Priority', flag: 'fPri' }], { note: '"Expired, not filed" = renewal date passed and status still Approved.' });
    { const d = new Date(t0.slice(0, 7) + '-01T00:00:00Z'); const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; const ms = [];
      for (let i = 0; i < 12; i++) { const x = new Date(d); x.setUTCMonth(d.getUTCMonth() + i); ms.push(x.toISOString().slice(0, 7)); }
      title('3. Renewal calendar – next 12 months from today'); headRow(['Month', 'Renewals due', 'Not yet filed (Approved)', 'Renewal already filed']);
      const first = row;
      ms.forEach(m => { ws.getCell(row, 1).value = `${MN[+m.slice(5) - 1]}-${m.slice(2, 4)}`;
        [[], [G('reg')], [G('ren')]].forEach((c, i) => { const cell = ws.getCell(row, i + 2); cell.value = CNT([['fRenM', xq('=M' + m), 'M' + m], ...c]); cell.numFmt = '#,##0'; }); row++; });
      ws.getCell(row, 1).value = 'TOTAL'; [0, 1, 2].forEach(i => { const L = colL(i + 1); let r = 0; for (let k = first; k < row; k++) r += ws.getCell(k, i + 2).value.result; ws.getCell(row, i + 2).value = { formula: `SUM(${L}${first}:${L}${row - 1})`, result: r }; });
      ws.getRow(row).eachCell(c => { c.font = { bold: true }; }); row += 2; }
    table('4. Ageing – Under MOH (since MOH submission) and With distributor (since dossier sent)', 'age', FIXED.age.filter(x => x !== '—'), [{ l: 'Registrations', hl: 1 }, { l: 'Priority', flag: 'fPri' }, { l: 'Open queries', flag: 'fOQ' }]);
    table('5. Queries from MOH / partners', 'qq', FIXED.qq.filter(x => x !== 'No open query'), [{ l: 'Registrations', hl: 1 }, { l: 'Under MOH', crit: [G('moh')] }, { l: 'With distributor', crit: [G('dist')] }, { l: 'Registered / renewal', crit: [G('reg')] }, { l: 'Under renewal', crit: [G('ren')] }]);
    { title('6. Pending samples, legal documents & fees'); headRow(['Item', 'Records pending', 'Under MOH', 'With distributor', 'Plan', 'Registered / renewal']);
      [['Samples', 'fPS'], ['Legal documents', 'fPL'], ['MOH fees', 'fPM'], ["Agent's fees", 'fPA']].forEach(([l, f]) => { ws.getCell(row, 1).value = l;
        [[], [G('moh')], [G('dist')], [G('plan')], [G('reg')]].forEach((c, i) => { const cell = ws.getCell(row, i + 2); cell.value = CNT(c, f); cell.numFmt = '#,##0'; }); row++; }); row++; }
    table('7. Blockers / delay reasons (open registrations)', 'blk', valsOf('blk').filter(x => x !== '(none)').concat(valsOf('blk').includes('(none)') ? ['(none)'] : []),
      [{ l: 'Open registrations', flag: 'fOpen', hl: 1 }, { l: 'Under MOH', crit: [G('moh')] }, { l: 'With distributor', crit: [G('dist')] }, { l: 'Plan', crit: [G('plan')] }, { l: 'On hold', crit: [G('hold')] }]);
    table('8. Registration pipeline by expected registration year (open registrations)', 'yr', valsOf('yr').filter(x => x !== '—'),
      [{ l: 'Total', hl: 1 }, { l: 'Under MOH', crit: [G('moh')] }, { l: 'With distributor', crit: [G('dist')] }, { l: 'Plan', crit: [G('plan')] }, { l: 'On hold', crit: [G('hold')] }, { l: 'Priority', flag: 'fPri' }], { note: 'Tentative Reg. Expected Date (Plan falls back to the dossier dispatch plan date).' });
    let n = 9;
    if (dCol.reg) table(`${n++}. Region-wise regulatory status`, 'reg', valsOf('reg'), statusCols);
    table(`${n++}. Country-wise regulatory status`, 'cty', valsOf('cty'), statusCols);
    table(`${n++}. Product-wise registrations`, 'pg', valsOf('pg'), statusCols);
    table(`${n++}. Therapy-wise registrations`, 'tc', valsOf('tc'), statusCols);
    table(`${n++}. RA owner-wise workload`, 'ra', valsOf('ra'), statusCols);
    table(`${n++}. BDM-wise`, 'bdm', valsOf('bdm'), statusCols);
    ws.getColumn(1).width = 40; for (let i = 2; i <= 16; i++) ws.getColumn(i).width = 14;
    for (let b = 0; b < 3; b++) { ws.getColumn(1 + b * 3).width = Math.max(ws.getColumn(1 + b * 3).width || 0, 22); ws.getColumn(2 + b * 3).width = Math.max(ws.getColumn(2 + b * 3).width || 0, 26); }
    ws.views = [{ state: 'frozen', ySplit: fStart + perCol, showGridLines: false }];
    /* ----- detail sheets ----- */
    for (const [v, l] of VIEWS) {
      if (v === 'dashboard' || v === 'list') continue;
      const t = compute(data, settings, scope, v, { ...opt, all: true, q: '' });
      if (t.empty) continue;
      const w = sheet(l.replace(/[\\\/\?\*\[\]:]/g, '-'), t);
      if (t.extra) { w.addRow([]); w.addRow([t.extra.title]).font = { bold: true, color: { argb: NAVY } }; writeTable(w, t.extra); }
    }
    /* ----- Data sheet ----- */
    const wd = wb.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1, xSplit: 2 }] });
    hdr(wd.addRow([...dims.map(d => d[1]), ...info.map(x => x[0]), ...flags.map(f => f[0])]));
    items.forEach((it, i) => { const o = R[i];
      const vals = [...dims.map(d => o[d[0]]), ...info.map(x => { const v = x[1](it); return x[3] === 'd' && v ? new Date(v + 'T00:00:00Z') : v; }), ...flags.map(f => o[f[0]])];
      const r = wd.addRow(vals); info.forEach((x, j) => { if (x[3] === 'd') r.getCell(nD + j + 1).numFmt = 'dd-mmm-yyyy'; }); });
    dims.forEach((d, i) => { wd.getColumn(i + 1).width = d[0] === 'cty' || d[0] === 'pg' || d[0] === 'grp' ? 22 : 16; });
    info.forEach((x, j) => { wd.getColumn(nD + j + 1).width = x[2]; });
    flags.forEach((f, j) => { wd.getColumn(nD + nI + j + 1).hidden = true; });
    wd.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: nD + nI } };
    /* ----- Lists sheet ----- */
    const wl = wb.addWorksheet('Lists', { state: 'hidden' });
    fdims.forEach((d, i) => { const oi = dims.indexOf(d); wl.getCell(1, i + 1).value = 'All'; opts[oi].forEach((v, k) => { wl.getCell(k + 2, i + 1).value = v; }); });
    return wb;
  }
  return { parser, parseWorkbook, compute, toXlsx, VIEWS };
});

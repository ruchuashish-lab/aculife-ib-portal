/*
 * Aculife-IB Portal – Sales calculation engine (combined International + Stericon file).
 * Shared by the server (Node) and the browser preview. Reads the "Data" sheet of the
 * "Combined International + Stericon Dashboard" workbook (values in USD Lacs, INR Cr reference).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SalesEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MONTHS = ['APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC', 'JAN', 'FEB', 'MAR'];
  const MN = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

  /* ---------------- parsing ---------------- */
  const cellVal = v => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v;
    if (typeof v === 'object') {
      if ('result' in v) return cellVal(v.result);
      if (v.richText) return v.richText.map(t => t.text).join('');
      if ('text' in v) return v.text;
      return '';
    }
    return v;
  };
  const norm = s => String(s == null ? '' : s).toUpperCase().replace(/\s+/g, ' ').trim();
  const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
  const hkey = s => norm(s).replace(/[^A-Z0-9/]/g, '');
  // row layout
  const C = { fy: 0, m: 1, k: 2, biz: 3, reg: 4, cty: 5, cust: 6, bdm: 7, mfg: 8, ch: 9, zone: 10, pg: 11, sku: 12, qty: 13, usd: 14, inr: 15 };
  const REQ = { biz: ['BUSINESS'], fy: ['FY'], type: ['TYPE'], reg: ['REGION'], cty: ['COUNTRY/STATE', 'COUNTRYSTATE', 'COUNTRY'], cust: ['CUSTOMER'], pg: ['PRODUCTGROUP'], usd: ['USDLACS', 'VALUEINUSDLACS'] };
  const OPT = { month: ['MONTH'], mno: ['MONTHNO'], bdm: ['BDM', 'BDM(FY27OWNER)'], mfg: ['MFGUNIT'], ch: ['CHANNEL'], zone: ['ZONE'], sku: ['SKU', 'PRODUCT(SKU)'], qty: ['QTYLACS'], inr: ['INRCR'] };

  function parser() {
    let idx = null; const rows = []; let skipped = 0;
    const find = (head, names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
    return {
      header(values) {
        const head = values.map(v => hkey(cellVal(v)));
        const m = {};
        for (const [k, names] of Object.entries(REQ)) { const i = find(head, names); if (i < 0) return false; m[k] = i; }
        for (const [k, names] of Object.entries(OPT)) m[k] = find(head, names);
        if (m.month < 0 && m.mno < 0) return false;
        idx = m; return true;
      },
      row(values) {
        const g = k => (idx[k] >= 0 ? cellVal(values[idx[k]]) : '');
        const fy = String(g('fy')).trim(); if (!/^\d{4}-\d{2}$/.test(fy)) { skipped++; return; }
        let mno = num(g('mno')); if (!(mno >= 1 && mno <= 12)) mno = MONTHS.indexOf(norm(g('month')).slice(0, 3)) + 1;
        if (!(mno >= 1 && mno <= 12)) { skipped++; return; }
        const t = norm(g('type'));
        const k = t === 'SALES' ? 0 : /BASIC/.test(t) ? 1 : /O\/?S/.test(t) ? 2 : /TARGET|TGT/.test(t) ? 1 : -1;
        if (k < 0) { skipped++; return; }
        const biz = /^S/.test(norm(g('biz'))) ? 'S' : 'I';
        rows.push([fy, mno, k, biz, norm(g('reg')), norm(g('cty')), norm(g('cust')), String(g('bdm') || '').trim() || '—', norm(g('mfg')),
          norm(g('ch')), norm(g('zone')), String(g('pg') || '').trim(), String(g('sku') || '').trim(), num(g('qty')), num(g('usd')), num(g('inr'))]);
      },
      finish(info) {
        if (!idx) throw new Error('Could not find the "Data" sheet with the combined International + Stericon columns (Business, FY, Month, Type, Region, Country / State, Customer, Product Group, USD Lacs …).');
        if (!rows.length) throw new Error('The Data sheet has no rows.');
        return { kind: 'CMB', rows, meta: { ...periods(rows), rows: rows.length, skipped, ...(info || {}) } };
      }
    };
  }
  function periods(rows) {
    const fys = [...new Set(rows.filter(r => r[2] === 0).map(r => r[0]))].sort();
    const cur = fys[fys.length - 1] || '';
    let ytdM = 0; for (const r of rows) if (r[2] === 0 && r[0] === cur && r[1] > ytdM) ytdM = r[1];
    return { fys, cur, y3: fys[fys.length - 2] || '', y2: fys[fys.length - 3] || '', y1: fys[fys.length - 4] || '', ytdM };
  }
  function parseWorkbook(wb, info) {
    const p = parser();
    const sheets = [wb.getWorksheet('Data'), ...wb.worksheets].filter(Boolean);
    for (const ws of sheets) {
      let first = true, use = false;
      ws.eachRow({ includeEmpty: false }, row => { const v = row.values.slice(1); if (first) { first = false; use = p.header(v); return; } if (use) p.row(v); });
      if (use) break;
    }
    return p.finish(info);
  }

  /* ---------------- region mapping ---------------- */
  const RALIAS = { 'GLOBAL INSTITUTION': 'Global Aid', 'GI': 'Global Aid', 'FWA': 'French West Africa' };
  const titleCase = u => u.toLowerCase().replace(/(^|[\s(\/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  function regMapper(settings) {
    const regs = {}; (settings.regions || []).forEach(r => { regs[norm(r)] = r; });
    const cache = {};
    return raw => {
      if (raw in cache) return cache[raw];
      const u = norm(raw); let out;
      if (regs[u]) out = regs[u]; else if (RALIAS[u] && regs[norm(RALIAS[u])]) out = regs[norm(RALIAS[u])]; else out = u ? titleCase(u) : 'Unmapped';
      return (cache[raw] = out);
    };
  }

  /* ---------------- aggregation ---------------- */
  function scopeRows(ds, scope, settings) {
    if (!ds) return [];
    const reg = regMapper(settings); const out = [];
    for (const r of ds.rows) {
      const region = reg(r[C.reg]);
      if (!scope.admin && !scope.regions.includes(region)) continue;
      if (scope.region && scope.region !== 'ALL' && region !== scope.region) continue;
      if (scope.biz && scope.biz !== 'ALL' && r[C.biz] !== scope.biz) continue;
      out.push({ r, region });
    }
    return out;
  }
  const blank = () => ({ y1: 0, y2: 0, y3: 0, ly: 0, cy: 0, bt: 0, bf: 0, ot: 0, of: 0, q3: 0, qly: 0, qcy: 0 });
  function add(a, r, P, vi) {
    const fy = r[0], m = r[1], k = r[2], v = r[vi];
    if (k === 0) {
      if (fy === P.y1) a.y1 += v; else if (fy === P.y2) a.y2 += v;
      else if (fy === P.y3) { a.y3 += v; a.q3 += r[C.qty]; if (m <= P.ytdM) { a.ly += v; a.qly += r[C.qty]; } }
      else if (fy === P.cur && m <= P.ytdM) { a.cy += v; a.qcy += r[C.qty]; }
    } else if (fy === P.cur) {
      if (k === 1) { a.bf += v; if (m <= P.ytdM) a.bt += v; }
      if (k === 2) { a.of += v; if (m <= P.ytdM) a.ot += v; }
    }
  }
  const div = (a, b) => (b ? a / b : null);
  const gr = (a, b) => (b ? a / b - 1 : (a ? 'New' : null));
  const status = ach => (ach === null ? '' : ach >= 1 ? 'On / above target' : ach >= 0.8 ? 'Close (80-100%)' : ach >= 0.5 ? 'Behind (50-80%)' : 'Critical (<50%)');
  function finalize(a, P, totY3) {
    const left = Math.max(1, 12 - P.ytdM);
    a.g32 = gr(a.y3, a.y2); a.cagr = a.y1 > 0 && a.y3 > 0 ? Math.pow(a.y3 / a.y1, 0.5) - 1 : null;
    a.share = div(a.y3, totY3); a.ytdg = gr(a.cy, a.ly);
    a.achB = div(a.cy, a.bt); a.achO = div(a.cy, a.ot);
    a.bal = a.bf - a.cy; a.req = a.bf ? a.bal / left : null; a.status = a.bf ? status(a.achB) : (a.cy || a.y3 ? 'No target' : '');
    a.rr = P.ytdM ? a.cy / P.ytdM : null;
    a.pr3 = div(a.y3, a.q3); a.prcy = div(a.cy, a.qcy);
    return a;
  }
  function group(items, P, keyFn, vi) {
    const map = new Map(); const tot = blank();
    for (const it of items) {
      const key = keyFn(it); const ks = key.map(x => String(x).toUpperCase()).join('\u0001');
      let g = map.get(ks); if (!g) { g = { key, a: blank() }; map.set(ks, g); }
      add(g.a, it.r, P, vi); add(tot, it.r, P, vi);
    }
    const rows = [...map.values()].map(g => ({ key: g.key, ...finalize(g.a, P, tot.y3) }));
    finalize(tot, P, tot.y3);
    rows.sort((x, y) => (y.cy + y.y3) - (x.cy + x.y3));
    return { rows, total: tot };
  }

  /* ---------------- views ---------------- */
  const fyL = fy => (fy ? 'FY ' + fy : '—');
  const ytdL = P => (P.ytdM ? `Apr–${MN[P.ytdM - 1]}` : '');
  function stdCols(P) {
    const y = ytdL(P);
    return [
      { k: 'y1', l: fyL(P.y1), f: 'v' }, { k: 'y2', l: fyL(P.y2), f: 'v' }, { k: 'y3', l: fyL(P.y3), f: 'v' },
      { k: 'g32', l: `Growth ${P.y3.slice(2)} vs ${P.y2.slice(2)}`, f: 'g' }, { k: 'cagr', l: '2-yr CAGR', f: 'g' }, { k: 'share', l: 'Share of ' + P.y3, f: 'p' },
      { k: 'ly', l: `YTD ${P.y3} (${y})`, f: 'v' }, { k: 'cy', l: `YTD ${P.cur} (${y})`, f: 'v', hl: 1 }, { k: 'ytdg', l: 'YTD growth', f: 'g' },
      { k: 'bt', l: 'YTD Basic Tgt', f: 'v' }, { k: 'achB', l: 'Ach % Basic', f: 'a' }, { k: 'ot', l: 'YTD O/S Tgt', f: 'v' }, { k: 'achO', l: 'Ach % O/S', f: 'a' },
      { k: 'bf', l: 'Full-yr Basic Tgt', f: 'v' }, { k: 'bal', l: 'Balance to Basic', f: 'v' }, { k: 'req', l: 'Req. per month', f: 'v' }, { k: 'status', l: 'Status vs Basic', f: 's' }
    ];
  }
  function table(title, unit, keyCols, grp, P, opts) {
    const cols = [...keyCols.map((l, i) => ({ k: 'k' + i, l, f: 't' })), ...stdCols(P)];
    const rows = grp.rows.map(g => { const o = { ...g }; g.key.forEach((v, i) => { o['k' + i] = v; }); return o; });
    const t = { title, unit, cols, rows, total: { ...grp.total, k0: 'TOTAL' } };
    if (opts && opts.limit) { t.rows = t.rows.filter(r => r.y1 || r.y2 || r.y3 || r.cy || r.bf).slice(0, opts.limit); }
    return t;
  }
  const BIZN = { I: 'International', S: 'Stericon' };
  function custStatus(a) { if (!a.ly && a.cy) return 'New / returning YTD'; if (a.ly && !a.cy) return 'No billing YTD'; if (!a.ly && !a.cy) return a.y3 ? 'Billed last year only' : 'Older history only'; return a.cy >= a.ly ? 'Growing YTD' : 'Declining YTD'; }
  function monthly(items, P, vi, unit) {
    const rows = MN.map((m, i) => ({ k0: m, mno: i + 1, y1: 0, y2: 0, y3: 0, cy: 0, bt: 0, ot: 0 }));
    for (const { r } of items) {
      const row = rows[r[1] - 1]; const v = r[vi];
      if (r[2] === 0) { if (r[0] === P.y1) row.y1 += v; else if (r[0] === P.y2) row.y2 += v; else if (r[0] === P.y3) row.y3 += v; else if (r[0] === P.cur) row.cy += v; }
      else if (r[0] === P.cur) { if (r[2] === 1) row.bt += v; else row.ot += v; }
    }
    let c3 = 0, cc = 0, cb = 0;
    rows.forEach(r => { r.ach = r.mno <= P.ytdM ? div(r.cy, r.bt) : null; if (r.mno <= P.ytdM) { c3 += r.y3; cc += r.cy; cb += r.bt; r.c3 = c3; r.cc = cc; r.cb = cb; r.cach = div(cc, cb); r.cg = gr(cc, c3); } else r.cy = null; });
    const cols = [{ k: 'k0', l: 'Month', f: 't' }, { k: 'y1', l: fyL(P.y1), f: 'v' }, { k: 'y2', l: fyL(P.y2), f: 'v' }, { k: 'y3', l: fyL(P.y3), f: 'v' }, { k: 'cy', l: fyL(P.cur) + ' actual', f: 'v', hl: 1 },
      { k: 'bt', l: 'Basic Tgt', f: 'v' }, { k: 'ot', l: 'O/S Tgt', f: 'v' }, { k: 'ach', l: 'Ach % Basic', f: 'a' }, { k: 'c3', l: 'Cum. ' + P.y3, f: 'v' }, { k: 'cc', l: 'Cum. ' + P.cur, f: 'v' },
      { k: 'cb', l: 'Cum. Basic Tgt', f: 'v' }, { k: 'cach', l: 'Cum. Ach %', f: 'a' }, { k: 'cg', l: 'Cum. growth', f: 'g' }];
    const tot = { k0: 'TOTAL' };['y1', 'y2', 'y3', 'cy', 'bt', 'ot'].forEach(k => { tot[k] = rows.reduce((a, r) => a + (r[k] || 0), 0); });
    return { title: 'Monthly trend vs target', unit, cols, rows, total: tot };
  }
  const VIEWS = [['dashboard', 'Dashboard'], ['summary', 'Summary'], ['business', 'Business'], ['region', 'Region'], ['regionbiz', 'Region × Business'], ['country', 'Country / State'], ['customer', 'Customer'],
    ['product', 'Product Group'], ['sku', 'SKU'], ['bdm', 'BDM'], ['channel', 'Channel'], ['mfg', 'Mfg Unit'], ['monthly', 'Monthly']];

  function compute(data, settings, scope, view, opt) {
    const ds = data && data.CMB; if (!ds) return { empty: true };
    opt = opt || {};
    const P = ds.meta, vi = opt.cur === 'INR' ? C.inr : C.usd, unit = opt.cur === 'INR' ? 'INR Crore (reference)' : 'USD Lacs';
    const items = scopeRows(ds, { ...scope, biz: opt.biz }, settings);
    const G = fn => group(items, P, fn, vi);
    if (view === 'dashboard') return dashboard(data, settings, scope, opt.filters, opt);
    switch (view) {
      case 'summary': {
        const t = G(() => ['T']).total; const bz = G(x => [x.r[C.biz]]);
        const b = k => bz.rows.find(r => r.key[0] === k) || finalize(blank(), P, 0);
        const y = ytdL(P);
        const cards = [
          { l: `FY ${P.y3} sales`, v: t.y3, f: 'v', s: `vs FY ${P.y2}: `, sv: t.g32, sf: 'g' },
          { l: `YTD ${P.cur} (${y})`, v: t.cy, f: 'v', s: `vs same months ${P.y3}: `, sv: t.ytdg, sf: 'g' },
          { l: 'Ach % vs Basic target (YTD)', v: t.achB, f: 'a', s: 'YTD Basic target: ', sv: t.bt, sf: 'v' },
          { l: 'Ach % vs O/S target (YTD)', v: t.achO, f: 'a', s: 'YTD O/S target: ', sv: t.ot, sf: 'v' },
          { l: 'Full-year Basic target', v: t.bf, f: 'v', s: 'Balance: ', sv: t.bal, sf: 'v' },
          { l: 'Required per month', v: t.req, f: 'v', s: 'Current run-rate: ', sv: t.rr, sf: 'v' },
          { l: `International YTD ${P.cur}`, v: b('I').cy, f: 'v', s: 'Ach % Basic: ', sv: b('I').achB, sf: 'a' },
          { l: `Stericon YTD ${P.cur}`, v: b('S').cy, f: 'v', s: 'Ach % target: ', sv: b('S').achB, sf: 'a' },
          { l: `YTD quantity ${P.cur}`, v: t.qcy, f: 'v', s: 'Lacs units · vs LY: ', sv: gr(t.qcy, t.qly), sf: 'g' }
        ];
        return { title: 'Summary', unit, cards, cols: [], rows: [], note: `${12 - P.ytdM} months remaining in FY ${P.cur}.` };
      }
      case 'business': { const t = table('Business-wise performance', unit, ['Business'], G(x => [BIZN[x.r[C.biz]]]), P); return t; }
      case 'region': return table('Region-wise performance', unit, ['Region'], G(x => [x.region]), P);
      case 'regionbiz': return table('Region × Business', unit, ['Region', 'Business'], G(x => [x.region, BIZN[x.r[C.biz]]]), P);
      case 'country': return table('Country / State-wise performance', unit, ['Country / State', 'Region', 'Business'], G(x => [x.r[C.cty], x.region, BIZN[x.r[C.biz]]]), P);
      case 'customer': { const t = table('Customer-wise performance', unit, ['Customer', 'Business', 'Country / State', 'Region'], G(x => [x.r[C.cust], BIZN[x.r[C.biz]], x.r[C.cty], x.region]), P);
        t.cols.push({ k: 'cst', l: 'Customer status', f: 's' }); t.rows.forEach(r => { r.cst = custStatus(r); }); t.rows = t.rows.filter(r => r.y1 || r.y2 || r.y3 || r.cy || r.bf); return t; }
      case 'product': return table('Product-group performance', unit, ['Product Group', 'Business'], G(x => [x.r[C.pg], BIZN[x.r[C.biz]]]), P);
      case 'sku': return table('SKU-level performance (top 500)', unit, ['SKU', 'Product Group', 'Business'], G(x => [x.r[C.sku] || x.r[C.pg], x.r[C.pg], BIZN[x.r[C.biz]]]), P, { limit: 500 });
      case 'bdm': { const t = table('BDM-wise performance (International)', unit, ['BDM'], group(items.filter(x => x.r[C.biz] === 'I'), P, x => [x.r[C.bdm]], vi), P); return t; }
      case 'channel': return table('Channel mix (Trade / Tender / Domestic / Export)', unit, ['Channel', 'Business'], G(x => [x.r[C.ch] || '—', BIZN[x.r[C.biz]]]), P);
      case 'mfg': return table('Manufacturing unit-wise', unit, ['Mfg Unit'], G(x => [x.r[C.mfg] || '—']), P);
      case 'monthly': return monthly(items, P, vi, unit);
    }
    return { empty: true };
  }

  /* ---------------- dashboard (filters + sections, like the workbook's Dashboard sheet) ---------------- */
  const DIMS = [['biz', 'Business', (r) => BIZN[r[C.biz]]], ['reg', 'Region', (r, g) => g], ['cty', 'Country / State', r => r[C.cty]], ['cust', 'Customer', r => r[C.cust]],
    ['bdm', 'BDM', r => r[C.bdm]], ['mfg', 'Mfg Unit', r => r[C.mfg] || '—'], ['ch', 'Channel', r => r[C.ch] || '—'], ['zone', 'Zone', r => r[C.zone] || '—']];
  function compactCols(P, keyCols) {
    const y = ytdL(P);
    return [...keyCols.map((l, i) => ({ k: 'k' + i, l, f: 't' })),
      { k: 'y1', l: fyL(P.y1), f: 'v' }, { k: 'y2', l: fyL(P.y2), f: 'v' }, { k: 'y3', l: fyL(P.y3), f: 'v' }, { k: 'g32', l: 'Growth', f: 'g' },
      { k: 'ly', l: `YTD ${P.y3}`, f: 'v' }, { k: 'cy', l: `YTD ${P.cur}`, f: 'v', hl: 1 }, { k: 'ytdg', l: 'YTD growth', f: 'g' },
      { k: 'bt', l: 'YTD Basic Tgt', f: 'v' }, { k: 'achB', l: 'Ach %', f: 'a' }, { k: 'bf', l: 'Full-yr Basic Tgt', f: 'v' }, { k: 'status', l: 'Status', f: 's' }];
  }
  function sec(title, P, keyCols, grp, limit, note) {
    let rows = grp.rows.map(g => { const o = { ...g }; g.key.forEach((v, i) => { o['k' + i] = v; }); return o; }).filter(r => r.y1 || r.y2 || r.y3 || r.cy || r.bf);
    const n = rows.length; if (limit) rows = rows.slice(0, limit);
    return { title, cols: compactCols(P, keyCols), rows, total: { ...grp.total, k0: 'TOTAL' }, note: limit && n > limit ? `Top ${limit} of ${n} shown – see the full list in the ${note || 'other'} view.` : '' };
  }
  function dashboard(data, settings, scope, filters, opt) {
    const ds = data && data.CMB; if (!ds) return { empty: true };
    opt = opt || {}; filters = filters || {};
    const P = ds.meta, vi = opt.cur === 'INR' ? C.inr : C.usd, unit = opt.cur === 'INR' ? 'INR Crore (reference)' : 'USD Lacs';
    const base = scopeRows(ds, { ...scope, biz: 'ALL' }, settings);
    const dims = DIMS.filter(d => scope.admin || d[0] !== 'mfg').filter(d => d[0] !== 'reg' || scope.admin || scope.regions.length > 1);
    const sel = {}; for (const d of dims) { const v = filters[d[0]]; if (Array.isArray(v) && v.length) sel[d[0]] = new Set(v.map(String)); }
    const vals = base.map(it => dims.map(d => String(d[2](it.r, it.region))));
    const passAll = (i, skip) => dims.every((d, j) => j === skip || !sel[d[0]] || sel[d[0]].has(vals[i][j]));
    const options = dims.map((d, j) => {
      const m = new Map();
      for (let i = 0; i < base.length; i++) {
        if (!passAll(i, j)) continue;
        const r = base[i].r; const v = vals[i][j];
        const w = r[2] === 0 && (r[0] === P.y3 || r[0] === P.cur) ? r[C.usd] : 0;
        m.set(v, (m.get(v) || 0) + w);
      }
      const opts = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
      return { k: d[0], l: d[1], opts, sel: sel[d[0]] ? [...sel[d[0]]] : [] };
    });
    const items = base.filter((_, i) => passAll(i, -1));
    const G = (fn, list) => group(list || items, P, fn, vi);
    const tot = G(() => ['T']).total;
    // headline KPIs (value in both currencies, quantity, realisation)
    const tU = group(items, P, () => ['T'], C.usd).total, tI = group(items, P, () => ['T'], C.inr).total;
    const krow = (l, a, f) => ({ k0: l, y1: a.y1, y2: a.y2, y3: a.y3, g32: gr(a.y3, a.y2), cagr: a.y1 > 0 && a.y3 > 0 ? Math.pow(a.y3 / a.y1, 0.5) - 1 : null, ly: a.ly, cy: a.cy, ytdg: gr(a.cy, a.ly), f });
    const qa = { y1: 0, y2: 0, y3: tU.q3, ly: tU.qly, cy: tU.qcy };
    for (const { r } of items) if (r[2] === 0) { if (r[0] === P.y1) qa.y1 += r[C.qty]; else if (r[0] === P.y2) qa.y2 += r[C.qty]; }
    const ua = { y1: 0, y2: 0, y3: tU.y3, ly: tU.ly, cy: tU.cy }; ua.y1 = tU.y1; ua.y2 = tU.y2;
    const pa = {}; ['y1', 'y2', 'y3', 'ly', 'cy'].forEach(k => { pa[k] = qa[k] ? ua[k] / qa[k] : null; });
    const y = ytdL(P);
    const kpi = {
      cols: [{ k: 'k0', l: 'KPI', f: 't' }, { k: 'y1', l: fyL(P.y1), f: 'v' }, { k: 'y2', l: fyL(P.y2), f: 'v' }, { k: 'y3', l: fyL(P.y3), f: 'v' }, { k: 'g32', l: 'Growth', f: 'g' }, { k: 'cagr', l: '2-yr CAGR', f: 'g' },
        { k: 'ly', l: `YTD ${P.y3} (${y})`, f: 'v' }, { k: 'cy', l: `YTD ${P.cur} (${y})`, f: 'v', hl: 1 }, { k: 'ytdg', l: 'YTD growth', f: 'g' }],
      rows: [krow('Sales value (USD Lacs)', tU), krow('Sales value (INR Cr – reference)', tI), krow('Sales qty (Lacs units)', qa), { ...krow('Avg realisation (USD / unit)', { ...pa, y1: pa.y1 || 0, y2: pa.y2 || 0, y3: pa.y3 || 0, ly: pa.ly || 0, cy: pa.cy || 0 }), y1: pa.y1, y2: pa.y2, y3: pa.y3, ly: pa.ly, cy: pa.cy, cagr: pa.y1 && pa.y3 ? Math.pow(pa.y3 / pa.y1, 0.5) - 1 : null }]
    };
    const left = 12 - P.ytdM;
    const gap = [
      { l: 'Full-year Basic target', v: tot.bf, f: 'v' }, { l: `YTD actual (${y})`, v: tot.cy, f: 'v' }, { l: 'Ach % vs YTD Basic target', v: tot.achB, f: 'a' },
      { l: 'Balance to Basic target', v: tot.bal, f: 'v' }, { l: 'Months remaining', v: left, f: 'n' }, { l: 'Required per month', v: tot.req, f: 'v' },
      { l: 'YTD run-rate per month', v: tot.rr, f: 'v' }, { l: 'Step-up needed vs run-rate', v: tot.rr ? (tot.req || 0) / tot.rr : null, f: 'x' },
      { l: 'Status vs Basic (YTD)', v: tot.bf ? status(tot.achB) : 'No target', f: 's' }, { l: 'Balance to O/S target', v: tot.of - tot.cy, f: 'v' }
    ];
    const isAdm = scope.admin;
    const sections = [
      sec('Countries / states in selection', P, ['Country / State', 'Region', 'Business'], G(x => [x.r[C.cty], x.region, BIZN[x.r[C.biz]]]), 40, 'Country / State'),
      { ...sec('Customers in selection', P, ['Customer', 'Business', 'Country / State'], G(x => [x.r[C.cust], BIZN[x.r[C.biz]], x.r[C.cty]]), 30, 'Customer') },
      sec('BDM in selection (International)', P, ['BDM'], G(x => [x.r[C.bdm]], items.filter(x => x.r[C.biz] === 'I'))),
      sec('Product groups in selection', P, ['Product Group', 'Business'], G(x => [x.r[C.pg], BIZN[x.r[C.biz]]]), 30, 'Product Group'),
      sec('SKUs in selection', P, ['SKU', 'Business', 'Product Group'], G(x => [x.r[C.sku] || x.r[C.pg], BIZN[x.r[C.biz]], x.r[C.pg]]), 30, 'SKU')
    ];
    const s2 = sections[1]; s2.cols.push({ k: 'cst', l: 'Customer status', f: 's' }); s2.rows.forEach(r => { r.cst = custStatus(r); });
    const mix = [['Business', x => [BIZN[x.r[C.biz]]]], ['Region', x => [x.region]], ['Channel', x => [x.r[C.ch] || '—']], ['Zone', x => [x.r[C.zone] || '—']]];
    if (isAdm) mix.push(['Mfg Unit', x => [x.r[C.mfg] || '—']]);
    const mixSecs = mix.map(([l, fn]) => sec('Segment mix – ' + l, P, [l], G(fn)));
    return { dashboard: true, title: 'Dashboard', unit, count: items.length, options, kpi, gap, monthly: monthly(items, P, vi, unit), sections: sections.concat(mixSecs) };
  }

  /* ---------------- Excel ---------------- */
  async function toXlsx(ExcelJS, data, settings, scope, label, opt) {
    const wb = new ExcelJS.Workbook(); wb.creator = 'Aculife-IB Portal';
    const NAVY = 'FF0B2A4A';
    const fmt = f => (f === 'v' ? '#,##0.00' : f === 'g' || f === 'p' || f === 'a' ? '0.0%' : '@');
    const hdr = (r) => r.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { wrapText: true, vertical: 'middle' }; });
    const addDashboard = (d) => {
      const ws = wb.addWorksheet('Dashboard');
      ws.addRow(['Aculife-IB – International + Stericon dashboard' + (label ? ' – ' + label : '')]).font = { bold: true, size: 14, color: { argb: NAVY } };
      ws.addRow([d.unit + ` · ${d.count.toLocaleString('en-IN')} rows in selection`]).font = { italic: true, color: { argb: 'FF666666' } };
      ws.addRow(['Active filters:']).font = { bold: true };
      for (const o of d.options) ws.addRow([o.l, o.sel.length ? o.sel.join(', ') : 'All']);
      const block = (title, t) => {
        ws.addRow([]); ws.addRow([title]).font = { bold: true, size: 12, color: { argb: NAVY } };
        hdr(ws.addRow(t.cols.map(c => c.l)));
        const put = (o, bold) => { const r = ws.addRow(t.cols.map(c => { const v = o[c.k]; return v === null || v === undefined ? '' : v; }));
          t.cols.forEach((c, i) => { const cell = r.getCell(i + 1); if (typeof cell.value === 'number') cell.numFmt = fmt(c.f); });
          if (bold) r.eachCell(c => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F6' } }; }); };
        if (t.total) put(t.total, true); t.rows.forEach(o => put(o));
        if (t.note) ws.addRow([t.note]).font = { italic: true, color: { argb: 'FF888888' } };
      };
      block('1. Headline KPIs', d.kpi);
      ws.addRow([]); ws.addRow(['2. FY target gap']).font = { bold: true, size: 12, color: { argb: NAVY } };
      for (const g of d.gap) { const r = ws.addRow([g.l, typeof g.v === 'number' ? g.v : (g.v || '')]); if (typeof g.v === 'number') r.getCell(2).numFmt = g.f === 'a' ? '0.0%' : g.f === 'n' ? '0' : g.f === 'x' ? '0.0"x"' : '#,##0.00'; }
      block('3. Monthly trend vs target', d.monthly);
      d.sections.forEach((s, i) => block(`${i + 4}. ${s.title}`, s));
      ws.getColumn(1).width = 36; for (let i = 2; i <= 16; i++) ws.getColumn(i).width = 14;
    };
    const addTable = (name, t) => {
      const ws = wb.addWorksheet(name.slice(0, 31));
      ws.addRow([t.title + (label ? ' – ' + label : '')]).font = { bold: true, size: 13, color: { argb: NAVY } };
      ws.addRow([(t.unit || '') + (t.note ? '. ' + t.note : '')]).font = { italic: true, color: { argb: 'FF666666' } };
      ws.addRow([]);
      if (t.cards) {
        ws.addRow(['KPI', 'Value', 'Detail']).eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; });
        for (const c of t.cards) { const r = ws.addRow([c.l, typeof c.v === 'number' ? c.v : '', (c.s || '') + (c.sv == null ? '' : typeof c.sv === 'number' ? (c.sf === 'v' ? c.sv.toFixed(2) : (c.sv * 100).toFixed(1) + '%') : c.sv)]); r.getCell(2).numFmt = fmt(c.f); }
        ws.getColumn(1).width = 34; ws.getColumn(2).width = 16; ws.getColumn(3).width = 40; return;
      }
      const hr = ws.addRow(t.cols.map(c => c.l)); hr.height = 32;
      hr.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { wrapText: true, vertical: 'middle' }; });
      const put = (o, bold) => {
        const r = ws.addRow(t.cols.map(c => { const v = o[c.k]; return v === null || v === undefined ? '' : v; }));
        t.cols.forEach((c, i) => { const cell = r.getCell(i + 1); if (typeof cell.value === 'number') cell.numFmt = fmt(c.f); });
        if (bold) r.eachCell(c => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F6' } }; });
      };
      if (t.total) put(t.total, true);
      t.rows.forEach(o => put(o));
      t.cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.f === 't' ? 26 : c.f === 's' ? 18 : 13; });
      ws.views = [{ state: 'frozen', ySplit: 4, xSplit: 1 }];
    };
    if (!data || !data.CMB) { wb.addWorksheet('No data').addRow(['No sales data uploaded yet.']); return wb; }
    const d = dashboard(data, settings, scope, (opt || {}).filters, opt);
    if (!d.empty) addDashboard(d);
    for (const [v, l] of VIEWS) { if (v === 'dashboard' || (v === 'mfg' && !scope.admin)) continue; const t = compute(data, settings, scope, v, opt); if (!t.empty) addTable(l.replace(/[\\\/\?\*\[\]:]/g, '-').replace(/ - /g, '-'), t); }
    return wb;
  }

  return { parser, parseWorkbook, compute, toXlsx, VIEWS, MONTHS };
});

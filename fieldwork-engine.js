/*
 * Aculife-IB Portal – Field Work engine (shared by the server and the browser).
 * Field visit / meeting log in the "Field Work Report" format:
 * Country | Date | Day | Meeting Count | Time | Partner/Distributor/RA/MOH/Hospital/Pharmacy |
 * Meeting attendees | Meeting Objective | Discussion | Action Points | TCD
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FieldWork = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TYPES = ['Partner', 'Distributor', 'RA', 'MOH', 'Hospital', 'Pharmacy', 'Other'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const dayOf = d => (isDate(d) ? DAYS[new Date(d + 'T00:00:00Z').getUTCDay()] : '');
  const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthOf = d => (isDate(d) ? `${MN[+d.slice(5, 7) - 1]}-${d.slice(0, 4)}` : '');
  const dmy = d => (isDate(d) ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '');
  const metWith = r => (r.partner ? r.partner + (r.type ? ` (${r.type})` : '') : r.type || '');
  const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

  // filter dimensions (multi-select) – value getters
  const DIMS = [['region', 'Region', r => r.region || '—'], ['country', 'Country', r => r.country || '—'], ['day', 'Day', r => dayOf(r.date) || '—'],
    ['month', 'Month', r => monthOf(r.date) || '—'], ['mc', 'Meeting Count', r => String(r.meetingNo || '—')], ['type', 'Met with (type)', r => r.type || '—'],
    ['partner', 'Partner / Distributor', r => r.partner || '—'], ['by', 'Entered by', r => r.createdBy || '—'], ['tcd', 'TCD status', r => tcdStatus(r)]];
  function tcdStatus(r) {
    if (!r.actions && !r.tcd) return 'No action point';
    if (!isDate(r.tcd)) return 'No TCD';
    const t = istToday(); if (r.tcd < t) return 'TCD passed';
    const days = (Date.parse(r.tcd) - Date.parse(t)) / 864e5; return days <= 7 ? 'TCD within 7 days' : 'TCD later';
  }
  const TCD_ORDER = ['TCD passed', 'TCD within 7 days', 'TCD later', 'No TCD', 'No action point'];
  // f = { from, to, q, region:[], country:[], ... }
  function filter(rows, f, skip) {
    f = f || {};
    const q = String(f.q || '').toLowerCase().trim();
    return rows.filter(r => {
      if (f.from && isDate(f.from) && !(r.date >= f.from)) return false;
      if (f.to && isDate(f.to) && !(r.date <= f.to)) return false;
      for (const d of DIMS) { if (d[0] === skip) continue; const s = f[d[0]]; if (Array.isArray(s) && s.length && !s.includes(d[2](r))) return false; }
      if (q && !['country', 'partner', 'type', 'attendees', 'objective', 'discussion', 'actions', 'createdBy', 'region', 'time'].some(k => String(r[k] || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }
  // drop-down options for each filter, cascading (each list respects the other filters)
  function options(rows, f, showRegion) {
    return DIMS.filter(d => showRegion || d[0] !== 'region').map(d => {
      const m = new Map(); for (const r of filter(rows, f, d[0])) { const v = d[2](r); m.set(v, (m.get(v) || 0) + 1); }
      let opts = [...m.keys()];
      if (d[0] === 'day') opts.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
      else if (d[0] === 'month') opts.sort((a, b) => { const k = x => (x.slice(4) + String(MN.indexOf(x.slice(0, 3))).padStart(2, '0')); return k(b).localeCompare(k(a)); });
      else if (d[0] === 'mc') opts.sort((a, b) => (+a || 999) - (+b || 999));
      else if (d[0] === 'tcd') opts.sort((a, b) => TCD_ORDER.indexOf(a) - TCD_ORDER.indexOf(b));
      else opts.sort((a, b) => (m.get(b) - m.get(a)) || a.localeCompare(b));
      const sel = Array.isArray(f[d[0]]) ? f[d[0]] : [];
      return { k: d[0], l: d[1], opts, sel };
    });
  }
  const sortRows = rows => rows.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.country).localeCompare(String(b.country)) || (a.meetingNo || 0) - (b.meetingNo || 0) || String(a.time).localeCompare(String(b.time)));
  function summary(rows) {
    const t = istToday();
    return {
      meetings: rows.length,
      days: new Set(rows.map(r => (r.createdBy || '') + '|' + r.date)).size,
      countries: new Set(rows.map(r => r.country)).size,
      partners: new Set(rows.filter(r => r.partner).map(r => r.partner.toLowerCase())).size,
      overdue: rows.filter(r => isDate(r.tcd) && r.tcd < t).length,
      due7: rows.filter(r => tcdStatus(r) === 'TCD within 7 days').length
    };
  }
  const filterText = (f, showRegion) => {
    const parts = [];
    if (f.from || f.to) parts.push(`Date ${f.from ? dmy(f.from) : '…'} to ${f.to ? dmy(f.to) : '…'}`);
    for (const d of DIMS) { if (!showRegion && d[0] === 'region') continue; const s = f[d[0]]; if (Array.isArray(s) && s.length) parts.push(`${d[1]}: ${s.join(', ')}`); }
    if (f.q) parts.push(`Search: "${f.q}"`);
    return parts.join(' · ');
  };

  /* -------- Excel in the Field Work Report format -------- */
  async function toXlsx(ExcelJS, rows, opt) {
    opt = opt || {}; const admin = !!opt.admin;
    rows = rows.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.country).localeCompare(String(b.country)) || (a.meetingNo || 0) - (b.meetingNo || 0) || String(a.time).localeCompare(String(b.time))); // report reads oldest → newest
    const wb = new ExcelJS.Workbook(); wb.creator = 'Aculife-IB Portal'; wb.created = new Date();
    const NAVY = 'FF0B2A4A';
    const ws = wb.addWorksheet('Field Work Report', { views: [{ state: 'frozen', ySplit: 2, xSplit: 0 }] });
    const cols = [['Country', 16], ['Date', 12], ['Day', 11], ['Meeting Count', 12.5], ['Time', 9], ['Partner/Distributor/RA/MOH/Hospital/Pharmacy', 40], ['Meeting attendees', 26],
      ['Meeting Objective', 30], ['Discussion', 55], ['Action Points', 40], ['TCD', 12]];
    if (admin) cols.push(['Region', 16], ['Entered by', 16]);
    cols.forEach(([, w], i) => { ws.getColumn(i + 1).width = w; });
    const ft = filterText(opt.filters || {}, admin);
    const t1 = ws.getCell(1, 1); t1.value = `Field Work Report – ${opt.label || 'All regions'}${ft ? ' – ' + ft : ''} (downloaded ${dmy(istToday())})`;
    t1.font = { bold: true, size: 12, color: { argb: NAVY } };
    const h = ws.getRow(2); cols.forEach(([l], i) => { h.getCell(i + 1).value = l; });
    h.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }; });
    h.height = 32;
    const D = s => (isDate(s) ? new Date(s + 'T00:00:00Z') : '');
    rows.forEach((r, i) => {
      const vals = [r.country, D(r.date), dayOf(r.date), r.meetingNo || '', r.time || '', metWith(r), r.attendees || '', r.objective || '', r.discussion || '', r.actions || '', D(r.tcd)];
      if (admin) vals.push(r.region || '', r.createdBy || '');
      const row = ws.addRow(vals);
      row.eachCell({ includeEmpty: true }, (c, n) => { c.alignment = { vertical: 'top', wrapText: true, horizontal: [2, 3, 4, 5, 11].includes(n) ? 'center' : 'left' };
        c.border = { top: { style: 'thin', color: { argb: 'FFD0D7DE' } }, bottom: { style: 'thin', color: { argb: 'FFD0D7DE' } }, left: { style: 'thin', color: { argb: 'FFD0D7DE' } }, right: { style: 'thin', color: { argb: 'FFD0D7DE' } } };
        if (i % 2) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8FA' } }; });
      row.getCell(2).numFmt = 'dd-mmm-yyyy'; row.getCell(11).numFmt = 'dd-mmm-yyyy';
      if (isDate(r.tcd) && r.tcd < istToday()) row.getCell(11).font = { color: { argb: 'FFC0392B' }, bold: true };
    });
    ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: cols.length } };
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, printTitlesRow: '2:2' };
    if (!rows.length) ws.addRow(['No field work entries for this selection.']);
    // Summary sheet
    const s = wb.addWorksheet('Summary');
    s.getColumn(1).width = 34; for (let i = 2; i <= 6; i++) s.getColumn(i).width = 14;
    s.addRow([`Field Work summary – ${opt.label || 'All regions'}`]).font = { bold: true, size: 12, color: { argb: NAVY } };
    if (ft) s.addRow([ft]).font = { italic: true, color: { argb: 'FF666666' } };
    const sm = summary(rows); s.addRow([]);
    [['Meetings', sm.meetings], ['Field days', sm.days], ['Countries visited', sm.countries], ['Partners / organisations met', sm.partners], ['Action points – TCD passed', sm.overdue], ['Action points – TCD within 7 days', sm.due7]]
      .forEach(([l, v]) => { const r = s.addRow([l, v]); r.getCell(2).font = { bold: true }; });
    const block = (title, key, extra) => {
      s.addRow([]); const hr = s.addRow([title, 'Meetings', 'Field days', 'Partners met']);
      hr.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; });
      const m = new Map(); for (const r of rows) { const k = key(r) || '—'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
      let ks = [...m.keys()]; ks = extra ? extra(ks) : ks.sort((a, b) => m.get(b).length - m.get(a).length || a.localeCompare(b));
      for (const k of ks) { const rs = m.get(k); s.addRow([k, rs.length, new Set(rs.map(r => (r.createdBy || '') + '|' + r.date)).size, new Set(rs.filter(r => r.partner).map(r => r.partner.toLowerCase())).size]); }
    };
    block('Country', r => r.country);
    if (admin) block('Region', r => r.region);
    block('Month', r => monthOf(r.date), ks => ks.sort((a, b) => { const k = x => x.slice(4) + String(MN.indexOf(x.slice(0, 3))).padStart(2, '0'); return k(b).localeCompare(k(a)); }));
    block('Met with (type)', r => r.type);
    block('Day', r => dayOf(r.date), ks => ks.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b)));
    if (admin) block('Entered by', r => r.createdBy);
    return wb;
  }
  return { TYPES, DIMS, dayOf, monthOf, dmy, metWith, isDate, filter, options, sortRows, summary, tcdStatus, filterText, toXlsx };
});

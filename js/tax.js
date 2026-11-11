// Chase / J.P. Morgan "Tax documents" CSV (the 1099 data download) and how it feeds the yearly numbers.
// Only the sale lots and yearly totals are kept. Name, address and account number are never stored.
import { parseCsv } from './csv.js';

export function isTax1099Csv(text) {
  return /1099B Data|1099Div Data/i.test(text.slice(0, 20000));
}

const n = (v) => {
  const x = parseFloat(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(x) ? x : 0;
};

/** Returns {year, lots, dividends, interest} */
export function parseTax1099Csv(text, fileName = '') {
  const rows = parseCsv(text);
  const sections = {};
  let current = null;
  for (const r of rows) {
    const first = (r[0] || '').trim();
    const m = first.match(/^(1099\w+) Data$/i);
    if (m && r.slice(1).every((c) => !c.trim())) { current = m[1].toUpperCase(); sections[current] = { header: null, rows: [] }; continue; }
    if (!current) continue;
    const sec = sections[current];
    if (!sec.header) {
      if (/no data found/i.test(first)) { current = null; continue; }
      sec.header = r.map((c) => c.trim().toLowerCase());
      continue;
    }
    sec.rows.push(r);
  }

  const col = (sec, re) => sec.header.findIndex((h) => re.test(h));
  const lots = [];
  const b = sections['1099B'];
  if (b?.header) {
    const iDesc = col(b, /box 1a/), iAcq = col(b, /box 1b/), iSold = col(b, /box 1c/), iProc = col(b, /box 1d/),
      iCost = col(b, /box 1e/), iWash = col(b, /box 1g/), iTerm = col(b, /box 2\)/), iCusip = col(b, /cusip/);
    for (const r of b.rows) {
      const desc = (r[iDesc] || '').trim();
      const sold = (r[iSold] || '').trim();
      if (!desc || !/^\d{4}-\d{2}-\d{2}/.test(sold)) continue;
      const dm = desc.match(/^([\d.,]+)\s*SH\.?\s*(.*)$/i);
      const quantity = dm ? n(dm[1]) : 0;
      const name = (dm ? dm[2] : desc).replace(/^\*+/, '').trim();
      const proceeds = n(r[iProc]), cost = n(r[iCost]), washSale = n(r[iWash]);
      const acquired = (r[iAcq] || '').trim();
      const term = /long/i.test(r[iTerm] || '') ? 'long' : 'short';
      lots.push({
        date: sold.slice(0, 10), year: Number(sold.slice(0, 4)),
        boughtDate: /^\d{4}-\d{2}-\d{2}/.test(acquired) ? acquired.slice(0, 10) : '',
        name, cusip: (r[iCusip] || '').trim(), quantity, proceeds, cost, washSale,
        // Wash-sale disallowed losses are added back, as on the 1099 / Form 8949.
        gain: proceeds - cost + washSale, term,
      });
    }
  }

  let dividends = 0, capGainDist = 0;
  const d = sections['1099DIV'];
  if (d?.header && d.rows[0]) {
    dividends = n(d.rows[0][col(d, /box 1a/)]);
    capGainDist = n(d.rows[0][col(d, /box 2a/)]);
  }
  let interest = 0;
  const i = sections['1099INT'];
  if (i?.header && i.rows[0]) interest = n(i.rows[0][col(i, /box 1\)|interest income/)]);

  const fromName = fileName.match(/(20\d\d)/);
  const soldYears = [...new Set(lots.map((l) => l.year))];
  const year = fromName ? Number(fromName[1]) : soldYears.length === 1 ? soldYears[0] : null;
  if (!year) throw new Error('Could not tell which tax year this file is for. Rename it to include the year, e.g. "2024 tax documents.csv".');
  const outside = lots.filter((l) => l.year !== year);
  if (outside.length) throw new Error(`The file name says ${year} but ${outside.length} sale(s) are dated in another year. Check you picked the right file.`);
  return { year, lots, dividends: dividends + capGainDist, interest };
}

/**
 * For every year with a 1099 imported, use the 1099's sales and dividend totals instead of
 * the ones worked out from the activity history. The 1099 is what goes to the IRS.
 */
export function applyTaxDocs(pf, taxDocs, symbolByName = {}) {
  const years = Object.keys(taxDocs || {}).map(Number);
  if (!years.length) return { ...pf, taxYears: new Set() };
  const taxYears = new Set(years);
  const realized = pf.realized.filter((r) => !taxYears.has(r.year));
  const income = pf.income.filter((r) => !taxYears.has(r.year));
  for (const y of years) {
    const doc = taxDocs[y];
    doc.lots.forEach((l, idx) => {
      const symbol = symbolByName[l.name.toUpperCase()] || l.name;
      realized.push({
        saleId: `1099-${y}-${l.date}-${l.cusip || l.name}`, // lots of one sale share an id
        lotId: `1099-${y}-${idx}`, boughtDate: l.boughtDate, date: l.date, year: y, symbol,
        quantity: l.quantity, cost: l.cost, proceeds: l.proceeds, gain: l.gain, term: l.term,
        washSale: l.washSale, source: '1099',
      });
    });
    if (doc.dividends) income.push({ date: `${y}-12-31`, year: y, symbol: '', type: 'DIVIDEND', amount: doc.dividends, source: '1099' });
    if (doc.interest) income.push({ date: `${y}-12-31`, year: y, symbol: '', type: 'INTEREST', amount: doc.interest, source: '1099' });
  }
  realized.sort((a, b) => a.date.localeCompare(b.date));
  return { ...pf, realized, income, taxYears };
}

/** Chase activity descriptions ("APPLE INC") -> ticker, so 1099 rows can show tickers. */
export function symbolMapFromTxns(txns) {
  const map = {};
  for (const t of txns) {
    if (t.symbol && t.note && ['BUY', 'SELL'].includes(t.type)) map[t.note.replace(/^\*+/, '').trim().toUpperCase()] = t.symbol;
  }
  return map;
}

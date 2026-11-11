// CSV import that tolerates Chase's activity export and similar broker files.
// Columns are matched by name, so their order doesn't matter.

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

// Header aliases, checked in order. First match wins.
const COLUMN_ALIASES = {
  date: ['trade date', 'transaction date', 'date', 'activity date', 'post date', 'settlement date'],
  type: ['type', 'transaction type', 'action', 'activity type', 'activity'],
  symbol: ['ticker', 'symbol', 'security symbol', 'symbol/cusip'],
  description: ['description', 'security description', 'security name', 'name'],
  quantity: ['quantity', 'qty', 'shares', 'units'],
  price: ['price usd', 'price', 'price ($)', 'execution price', 'unit price'],
  amount: ['amount usd', 'amount', 'net amount', 'amount ($)', 'total', 'value'],
  fees: ['commission', 'commissions', 'fees', 'fee', 'commission/fees', 'fees & comm'],
};

function findHeaderRow(rows) {
  // Broker exports often have a few title lines before the real header.
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = rows[i].map((c) => c.trim().toLowerCase());
    const hasDate = cells.some((c) => c.includes('date'));
    const hasQty = cells.some((c) => ['quantity', 'qty', 'shares'].includes(c));
    if (hasDate && hasQty) return i;
  }
  return 0;
}

export function mapColumns(header) {
  const h = header.map((c) => c.trim().toLowerCase());
  const map = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const a of aliases) {
      const idx = h.indexOf(a);
      if (idx !== -1 && !Object.values(map).includes(idx)) { map[key] = idx; break; }
    }
  }
  return map;
}

const num = (v) => {
  if (v == null) return NaN;
  let s = String(v).trim();
  if (!s) return NaN;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[$,()\s-]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
};

export function detectType(typeText, description, quantity, amount) {
  const s = `${typeText} ${description}`.toLowerCase();
  if (/reinvest/.test(s)) return 'BUY'; // dividend reinvestment = buying shares
  if (/\bsplit\b/.test(s)) return 'SPLIT';
  if (/dividend|\bdiv\b|cap(ital)? gain/.test(s)) return 'DIVIDEND';
  if (/interest/.test(s)) return 'INTEREST';
  if (/\b(buy|bought|purchase)\b/.test(s)) return 'BUY';
  if (/\b(sell|sold|sale|redemption)\b/.test(s)) return 'SELL';
  if (/\b(fee|commission|adr)\b/.test(s)) return 'FEE';
  if (/deposit|transfer in|contribution|ach in|journal in/.test(s)) return 'DEPOSIT';
  if (/withdraw|transfer out|ach out|disbursement/.test(s)) return 'WITHDRAWAL';
  // Fall back on signs: shares in + cash out = buy.
  if (Number.isFinite(quantity) && quantity !== 0) return quantity > 0 ? 'BUY' : 'SELL';
  if (Number.isFinite(amount) && amount !== 0 && !s.trim()) return amount > 0 ? 'DEPOSIT' : 'WITHDRAWAL';
  return null;
}

function toIsoDate(v) {
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

/** Returns {txns, skipped: [{line, reason}], columns} */
export function importBrokerCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { txns: [], skipped: [], columns: {} };
  const headerIdx = findHeaderRow(rows);
  const cols = mapColumns(rows[headerIdx]);
  if (cols.date == null) throw new Error('Could not find a date column. Expected a header like "Trade Date" or "Date".');
  const txns = [];
  const skipped = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k) => (cols[k] == null ? '' : r[cols[k]] ?? '');
    const date = toIsoDate(get('date'));
    if (!date) { skipped.push({ line: i + 1, reason: 'no valid date' }); continue; }
    const quantity = num(get('quantity'));
    const amount = num(get('amount'));
    const type = detectType(get('type'), get('description'), quantity, amount);
    if (!type) { skipped.push({ line: i + 1, reason: `unrecognised type "${get('type') || get('description')}"` }); continue; }
    let symbol = get('symbol').trim().toUpperCase();
    if (['BUY', 'SELL', 'SPLIT'].includes(type) && !symbol) { skipped.push({ line: i + 1, reason: 'trade without a ticker' }); continue; }
    const price = num(get('price'));
    const fees = num(get('fees'));
    txns.push({
      date, type, symbol,
      quantity: Number.isFinite(quantity) ? Math.abs(quantity) : 0,
      price: Number.isFinite(price) ? Math.abs(price) : 0,
      fees: Number.isFinite(fees) ? Math.abs(fees) : 0,
      amount: Number.isFinite(amount) ? Math.abs(amount) : null,
      note: get('description').trim(),
    });
  }
  return { txns, skipped, columns: cols };
}

export function toCsv(txns) {
  const head = ['Date', 'Type', 'Symbol', 'Quantity', 'Price', 'Fees', 'Amount', 'Note'];
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [head.join(','), ...txns.map((t) =>
    [t.date, t.type, t.symbol, t.quantity, t.price, t.fees, t.amount ?? '', t.note || ''].map(esc).join(','))].join('\n');
}

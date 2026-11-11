// Pure portfolio math: no DOM, no network. Shared by the app and the tests.

export const TYPES = ['BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'FEE', 'SPLIT', 'DEPOSIT', 'WITHDRAWAL'];

const round = (n, d = 2) => Math.round((n + Number.EPSILON) * 10 ** d) / 10 ** d;

/** Clean up one transaction so the math below can trust it. */
export function normalizeTxn(t) {
  const type = String(t.type || '').toUpperCase();
  const quantity = Math.abs(Number(t.quantity) || 0);
  const price = Math.abs(Number(t.price) || 0);
  const fees = Math.abs(Number(t.fees) || 0);
  const rawAmount = t.amount === '' || t.amount == null ? null : Number(t.amount);
  return {
    id: t.id || cryptoId(),
    date: String(t.date).slice(0, 10),
    type,
    symbol: String(t.symbol || '').trim().toUpperCase(),
    quantity,
    price,
    fees,
    amount: Number.isFinite(rawAmount) ? Math.abs(rawAmount) : null,
    note: t.note || '',
  };
}

function cryptoId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Replay transactions oldest-first using FIFO lots (the IRS default and what
 * Chase reports unless you pick specific lots).
 */
export function computePortfolio(rawTxns) {
  const txns = rawTxns.map(normalizeTxn).sort((a, b) => a.date.localeCompare(b.date));
  const lots = {}; // symbol -> [{date, qty, costPerShare}]
  const realized = [];
  const income = []; // dividends + interest
  const fees = [];
  const cashFlows = []; // deposits (+) / withdrawals (-)
  const buys = [];
  const warnings = [];

  for (const t of txns) {
    const year = Number(t.date.slice(0, 4));
    switch (t.type) {
      case 'BUY': {
        if (!t.symbol || !t.quantity) { warnings.push(`Skipped BUY on ${t.date}: missing symbol or quantity`); break; }
        const total = t.amount ?? t.quantity * t.price + t.fees;
        (lots[t.symbol] ||= []).push({ date: t.date, qty: t.quantity, costPerShare: total / t.quantity });
        buys.push({ date: t.date, year, symbol: t.symbol, amount: total });
        break;
      }
      case 'SELL': {
        const queue = lots[t.symbol] || [];
        const held = queue.reduce((s, l) => s + l.qty, 0);
        let toSell = t.quantity;
        if (toSell > held + 1e-9) {
          warnings.push(`SELL of ${t.quantity} ${t.symbol} on ${t.date} exceeds the ${round(held, 4)} shares held; extra ignored`);
          toSell = held;
        }
        if (toSell <= 0) break;
        const proceedsTotal = t.amount ?? t.quantity * t.price - t.fees;
        const proceedsPerShare = proceedsTotal / t.quantity;
        while (toSell > 1e-9 && queue.length) {
          const lot = queue[0];
          const q = Math.min(lot.qty, toSell);
          const cost = q * lot.costPerShare;
          const proceeds = q * proceedsPerShare;
          const days = (Date.parse(t.date) - Date.parse(lot.date)) / 86400000;
          realized.push({
            date: t.date, year, symbol: t.symbol, quantity: q,
            cost, proceeds, gain: proceeds - cost,
            term: days > 365 ? 'long' : 'short',
          });
          lot.qty -= q;
          toSell -= q;
          if (lot.qty <= 1e-9) queue.shift();
        }
        break;
      }
      case 'DIVIDEND':
      case 'INTEREST':
        income.push({ date: t.date, year, symbol: t.symbol, type: t.type, amount: t.amount ?? t.quantity * t.price });
        break;
      case 'FEE':
        fees.push({ date: t.date, year, symbol: t.symbol, amount: t.amount ?? t.fees });
        break;
      case 'SPLIT': {
        // quantity = extra shares received. Spread them across open lots, keeping total cost.
        const queue = lots[t.symbol] || [];
        const held = queue.reduce((s, l) => s + l.qty, 0);
        if (!held) { warnings.push(`SPLIT for ${t.symbol} on ${t.date} but no shares held`); break; }
        const ratio = (held + t.quantity) / held;
        for (const lot of queue) { lot.qty *= ratio; lot.costPerShare /= ratio; }
        break;
      }
      case 'DEPOSIT':
        cashFlows.push({ date: t.date, year, amount: t.amount ?? 0 });
        break;
      case 'WITHDRAWAL':
        cashFlows.push({ date: t.date, year, amount: -(t.amount ?? 0) });
        break;
      default:
        warnings.push(`Unknown type "${t.type}" on ${t.date}; ignored`);
    }
  }

  const positions = Object.entries(lots)
    .map(([symbol, q]) => {
      const quantity = q.reduce((s, l) => s + l.qty, 0);
      const cost = q.reduce((s, l) => s + l.qty * l.costPerShare, 0);
      return { symbol, quantity, cost, avgCost: quantity ? cost / quantity : 0, firstBuy: q[0]?.date, lots: q };
    })
    .filter((p) => p.quantity > 1e-6)
    .sort((a, b) => b.cost - a.cost);

  return { txns, positions, realized, income, fees, cashFlows, buys, warnings };
}

/** Attach live prices to positions. prices: {SYM: number} */
export function valuePositions(positions, prices) {
  return positions.map((p) => {
    const price = prices[p.symbol];
    const hasPrice = Number.isFinite(price) && price > 0;
    const value = hasPrice ? p.quantity * price : null;
    const unrealized = hasPrice ? value - p.cost : null;
    return { ...p, price: hasPrice ? price : null, value, unrealized, unrealizedPct: hasPrice && p.cost ? unrealized / p.cost : null };
  });
}

/** Year-by-year summary. The current year also gets unrealized P&L ("paper" gains as of today). */
export function yearlySummary(pf, valued, today = new Date()) {
  const thisYear = today.getFullYear();
  const years = new Set([
    ...pf.buys.map((b) => b.year), ...pf.realized.map((r) => r.year),
    ...pf.income.map((i) => i.year), ...pf.fees.map((f) => f.year), thisYear,
  ]);
  const minYear = Math.min(...years);
  const rows = [];
  for (let y = minYear; y <= thisYear; y++) {
    const sum = (arr, key = 'amount') => arr.filter((x) => x.year === y).reduce((s, x) => s + x[key], 0);
    const realizedGain = sum(pf.realized, 'gain');
    const shortTerm = pf.realized.filter((r) => r.year === y && r.term === 'short').reduce((s, r) => s + r.gain, 0);
    const longTerm = realizedGain - shortTerm;
    const income = sum(pf.income);
    const fees = sum(pf.fees);
    const invested = sum(pf.buys);
    const proceeds = sum(pf.realized, 'proceeds');
    rows.push({
      year: y, invested, proceeds, realizedGain, shortTerm, longTerm, income, fees,
      net: realizedGain + income - fees,
    });
  }
  const totals = rows.reduce((t, r) => {
    for (const k of Object.keys(r)) if (k !== 'year') t[k] = (t[k] || 0) + r[k];
    return t;
  }, {});
  const priced = valued.filter((p) => p.value != null);
  const unrealized = priced.reduce((s, p) => s + p.unrealized, 0);
  const marketValue = priced.reduce((s, p) => s + p.value, 0);
  const openCost = valued.reduce((s, p) => s + p.cost, 0);
  return {
    rows,
    totals: {
      ...totals,
      unrealized,
      marketValue,
      openCost,
      missingPrices: valued.length - priced.length,
      totalPnl: (totals.net || 0) + unrealized,
      // Return on everything you ever put in (simple, not time-weighted).
      totalReturnPct: totals.invested ? ((totals.net || 0) + unrealized) / totals.invested : 0,
    },
  };
}

export { round };

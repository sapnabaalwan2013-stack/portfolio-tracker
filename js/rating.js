// Turns market signals into a 0-100 score, a letter grade, Buy/Hold/Sell and a plain-English note.
// It's a rules-based screen, not a prediction. Pure functions so they can be unit-tested.

const POSITIVE = ['beat', 'beats', 'surge', 'surges', 'soar', 'soars', 'jump', 'jumps', 'rally', 'record', 'upgrade', 'upgraded',
  'outperform', 'raises', 'raised', 'growth', 'strong', 'profit', 'gain', 'gains', 'bullish', 'buyback', 'approval', 'approved',
  'expands', 'wins', 'win', 'tops', 'boost', 'boosts', 'higher', 'rebound', 'breakthrough', 'partnership'];
const NEGATIVE = ['miss', 'misses', 'plunge', 'plunges', 'drop', 'drops', 'fall', 'falls', 'slump', 'downgrade', 'downgraded',
  'underperform', 'cuts', 'cut', 'lawsuit', 'probe', 'investigation', 'weak', 'loss', 'losses', 'bearish', 'recall', 'layoffs',
  'warning', 'warns', 'slows', 'decline', 'declines', 'lower', 'fraud', 'tumble', 'tumbles', 'sinks', 'fine', 'delay', 'halt'];

/** Very simple headline sentiment: returns -1..1, or null when there's nothing to read. */
export function headlineSentiment(headlines) {
  if (!headlines?.length) return null;
  let total = 0, counted = 0;
  for (const h of headlines) {
    const words = String(h).toLowerCase().match(/[a-z]+/g) || [];
    let s = 0;
    for (const w of words) {
      if (POSITIVE.includes(w)) s++;
      if (NEGATIVE.includes(w)) s--;
    }
    if (s !== 0) { total += Math.sign(s); counted++; }
  }
  if (!counted) return 0;
  return total / headlines.length; // neutral headlines pull towards 0
}

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

/**
 * signals = {
 *   rec: {strongBuy, buy, hold, sell, strongSell} | null,   // latest analyst month
 *   ret13w, ret26w, ret52w: percent numbers (e.g. 12.5) | null,
 *   price, high52, low52: numbers | null,
 *   newsSentiment: -1..1 | null,
 *   marketMood: -1..1 | null,                               // broad market, from SPY trend + headlines
 *   position: {unrealizedPct (fraction), weight (fraction of portfolio)} | null
 * }
 */
export function rateStock(s) {
  const parts = [];
  const reasons = [];

  if (s.rec) {
    const { strongBuy = 0, buy = 0, hold = 0, sell = 0, strongSell = 0 } = s.rec;
    const n = strongBuy + buy + hold + sell + strongSell;
    if (n > 0) {
      const avg = (2 * strongBuy + buy - sell - 2 * strongSell) / n; // -2..2
      const score = clamp(50 + avg * 25);
      parts.push({ key: 'Analysts', score, weight: 35 });
      const bullish = Math.round(((strongBuy + buy) / n) * 100);
      reasons.push(`${bullish}% of ${n} analysts rate it Buy`);
    }
  }

  const rets = [s.ret13w, s.ret26w].filter((v) => Number.isFinite(v));
  if (rets.length) {
    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
    const score = clamp(50 + avg * 1.5); // +33% over the period ≈ 100
    parts.push({ key: 'Momentum', score, weight: 25 });
    if (Number.isFinite(s.ret26w)) reasons.push(`${s.ret26w >= 0 ? 'up' : 'down'} ${Math.abs(s.ret26w).toFixed(1)}% over 6 months`);
  }

  if ([s.price, s.high52, s.low52].every(Number.isFinite) && s.high52 > s.low52) {
    const pos = (s.price - s.low52) / (s.high52 - s.low52); // 0 = at low, 1 = at high
    const score = clamp(pos * 100);
    parts.push({ key: 'Trend', score, weight: 15 });
    const offHigh = ((s.high52 - s.price) / s.high52) * 100;
    reasons.push(offHigh < 3 ? 'trading near its 52-week high' : `${offHigh.toFixed(0)}% below its 52-week high`);
  }

  if (Number.isFinite(s.newsSentiment)) {
    const score = clamp(50 + s.newsSentiment * 100);
    parts.push({ key: 'News', score, weight: 15 });
    if (s.newsSentiment > 0.15) reasons.push('recent headlines lean positive');
    else if (s.newsSentiment < -0.15) reasons.push('recent headlines lean negative');
  }

  if (Number.isFinite(s.marketMood)) {
    parts.push({ key: 'Market', score: clamp(50 + s.marketMood * 50), weight: 10 });
  }

  if (!parts.length) {
    return { score: null, grade: '—', action: 'N/A', parts, note: 'Not enough market data to rate this holding yet.' };
  }

  const wSum = parts.reduce((a, p) => a + p.weight, 0);
  const score = Math.round(parts.reduce((a, p) => a + p.score * p.weight, 0) / wSum);
  const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 38 ? 'D' : 'F';
  let action = score >= 65 ? 'BUY' : score < 40 ? 'SELL' : 'HOLD';

  // Position-aware advice on top of the signal.
  const tips = [];
  const pos = s.position;
  if (pos) {
    if (pos.weight > 0.25) tips.push(`It is ${(pos.weight * 100).toFixed(0)}% of your portfolio, so adding more raises concentration risk`);
    if (Number.isFinite(pos.unrealizedPct)) {
      const pct = pos.unrealizedPct * 100;
      if (pct > 50 && action !== 'BUY') tips.push(`you're up ${pct.toFixed(0)}%; consider trimming or setting a trailing stop to lock in gains`);
      else if (pct < -25 && action === 'SELL') tips.push(`you're down ${Math.abs(pct).toFixed(0)}% with weak signals; recheck why you bought it (a realized loss can offset gains for taxes)`);
      else if (pct < -25) tips.push(`you're down ${Math.abs(pct).toFixed(0)}%; only average down if your original reason still holds`);
    }
  }
  const rawAction = action;
  if (action === 'BUY' && pos && pos.weight > 0.25) action = 'HOLD';

  const lead = {
    BUY: 'Signals are favourable',
    HOLD: rawAction === 'BUY' ? 'Signals are favourable, but hold rather than add' : 'Signals are mixed',
    SELL: 'Signals are weak',
  }[action];
  const note = `${lead}: ${reasons.join(', ') || 'limited data'}.` + (tips.length ? ` Note: ${tips.join('; ')}.` : '');
  return { score, grade, action, parts, note };
}

/** Broad market mood from SPY returns and general headlines: -1..1 */
export function marketMood({ spyRet13w, spyRet26w, headlines }) {
  const vals = [];
  if (Number.isFinite(spyRet13w)) vals.push(clamp(spyRet13w / 10, -1, 1));
  if (Number.isFinite(spyRet26w)) vals.push(clamp(spyRet26w / 15, -1, 1));
  const hs = headlineSentiment(headlines);
  if (hs != null) vals.push(clamp(hs * 2, -1, 1));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function moodLabel(m) {
  if (m == null) return 'Unknown';
  if (m > 0.35) return 'Risk-on (bullish)';
  if (m > 0.1) return 'Mildly bullish';
  if (m >= -0.1) return 'Neutral';
  if (m >= -0.35) return 'Mildly bearish';
  return 'Risk-off (bearish)';
}

// Live market data from Finnhub (free tier: 60 calls/minute). Get a key at https://finnhub.io/register
// Responses are cached in localStorage so reloading the page doesn't burn through the limit.

const BASE = 'https://finnhub.io/api/v1';
const MINUTE = 60000;
const TTL = {
  quote: 2 * MINUTE,
  metric: 12 * 60 * MINUTE,
  rec: 12 * 60 * MINUTE,
  news: 30 * MINUTE,
  earnings: 6 * 60 * MINUTE,
  profile: 7 * 24 * 60 * MINUTE,
};

// Simple limiter: at most 50 requests per rolling minute, 4 at a time.
const stamps = [];
let active = 0;
const waiters = [];
async function slot() {
  for (;;) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > MINUTE) stamps.shift();
    if (stamps.length < 50 && active < 4) { stamps.push(now); active++; return; }
    await new Promise((r) => { waiters.push(r); setTimeout(r, 400); });
  }
}
function release() { active--; const w = waiters.shift(); if (w) w(); }

function cacheGet(key, ttl) {
  try {
    const raw = localStorage.getItem('fh:' + key);
    if (!raw) return undefined;
    const { t, v } = JSON.parse(raw);
    return Date.now() - t < ttl ? v : undefined;
  } catch { return undefined; }
}
function cacheSet(key, v) {
  try { localStorage.setItem('fh:' + key, JSON.stringify({ t: Date.now(), v })); } catch { /* storage full: skip cache */ }
}
export function clearMarketCache() {
  try { Object.keys(localStorage).filter((k) => k.startsWith('fh:')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
}

export class Finnhub {
  constructor(apiKey) { this.key = apiKey; }

  async get(path, params, ttl, { force = false } = {}) {
    const qs = new URLSearchParams(params).toString();
    const cacheKey = `${path}?${qs}`;
    if (!force) { const hit = cacheGet(cacheKey, ttl); if (hit !== undefined) return hit; }
    await slot();
    try {
      const res = await fetch(`${BASE}${path}?${qs}&token=${encodeURIComponent(this.key)}`);
      if (res.status === 401) throw new Error('Finnhub rejected the API key. Check it in Settings.');
      if (res.status === 403) return null; // endpoint not on the free plan
      if (res.status === 429) throw new Error('Finnhub rate limit hit. Wait a minute and refresh.');
      if (!res.ok) throw new Error(`Finnhub ${path} failed (${res.status})`);
      const data = await res.json();
      cacheSet(cacheKey, data);
      return data;
    } finally { release(); }
  }

  quote(symbol, opts) { return this.get('/quote', { symbol }, TTL.quote, opts); }
  metrics(symbol) { return this.get('/stock/metric', { symbol, metric: 'all' }, TTL.metric); }
  recommendation(symbol) { return this.get('/stock/recommendation', { symbol }, TTL.rec); }
  profile(symbol) { return this.get('/stock/profile2', { symbol }, TTL.profile); }

  companyNews(symbol, days = 7) {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    return this.get('/company-news', { symbol, from: iso(from), to: iso(to) }, TTL.news);
  }
  marketNews() { return this.get('/news', { category: 'general' }, TTL.news); }

  earnings(symbol, days = 120) {
    const from = new Date();
    const to = new Date(from.getTime() + days * 86400000);
    return this.get('/calendar/earnings', { symbol, from: iso(from), to: iso(to) }, TTL.earnings);
  }
}

const iso = (d) => d.toISOString().slice(0, 10);

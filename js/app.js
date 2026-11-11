import { computePortfolio, valuePositions, yearlySummary, normalizeTxn } from './portfolio.js';
import { importBrokerCsv, toCsv } from './csv.js';
import { Finnhub, clearMarketCache } from './market.js';
import { rateStock, headlineSentiment, marketMood, moodLabel } from './rating.js';
import { upcomingMacro } from './events.js';

// ---------- storage ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('pt:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pt:' + k, JSON.stringify(v)); } catch (e) { showBanner('Could not save to browser storage: ' + e.message, 'err'); } },
  del(k) { try { localStorage.removeItem('pt:' + k); } catch { /* ignore */ } },
};

let txns = store.get('txns', []);
let apiKey = store.get('key', '');
const market = { quotes: {}, metrics: {}, recs: {}, news: {}, profiles: {}, earnings: [], marketNews: [], spy: null, loadedAt: null };
const charts = {};

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n, sign = false) => n == null || !Number.isFinite(n) ? '—'
  : (sign && n > 0 ? '+' : '') + n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const pct = (n, sign = true) => n == null || !Number.isFinite(n) ? '—' : (sign && n > 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const compact = (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const qty = (n) => Number(n.toFixed(4)).toLocaleString('en-US', { maximumFractionDigits: 4 });
const fmtDate = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function showBanner(msg, kind = 'warn') {
  $('#banner').innerHTML = msg ? `<div class="alert ${kind}">${msg}</div>` : '';
}
function setStatus(s) { $('#status').textContent = s; }

// ---------- tabs ----------
function selectTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
  try { sessionStorage.setItem('pt:tab', name); } catch { /* ignore */ }
  if (name === 'dashboard') drawCharts();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

// ---------- theme ----------
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
applyTheme(store.get('theme', null));
$('#theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  store.set('theme', next);
  applyTheme(next);
  drawCharts();
});

// ---------- derived state ----------
function derive() {
  const pf = computePortfolio(txns);
  const prices = {};
  for (const [s, q] of Object.entries(market.quotes)) if (q && q.c > 0) prices[s] = q.c;
  const valued = valuePositions(pf.positions, prices);
  const summary = yearlySummary(pf, valued);
  const totalValue = valued.reduce((s, p) => s + (p.value ?? p.cost), 0);

  const mood = marketMood({
    spyRet13w: market.spy?.metric?.['13WeekPriceReturnDaily'],
    spyRet26w: market.spy?.metric?.['26WeekPriceReturnDaily'],
    headlines: market.marketNews.slice(0, 40).map((n) => n.headline),
  });

  const rated = valued.map((p) => {
    const m = market.metrics[p.symbol]?.metric || {};
    const recs = market.recs[p.symbol];
    const news = market.news[p.symbol] || [];
    const rating = rateStock({
      rec: Array.isArray(recs) && recs.length ? recs[0] : null,
      ret13w: m['13WeekPriceReturnDaily'],
      ret26w: m['26WeekPriceReturnDaily'],
      price: p.price, high52: m['52WeekHigh'], low52: m['52WeekLow'],
      newsSentiment: news.length ? headlineSentiment(news.slice(0, 25).map((n) => n.headline)) : null,
      marketMood: mood,
      position: { unrealizedPct: p.unrealizedPct, weight: totalValue ? (p.value ?? p.cost) / totalValue : 0 },
    });
    return { ...p, rating, weight: totalValue ? (p.value ?? p.cost) / totalValue : 0, quote: market.quotes[p.symbol], profile: market.profiles[p.symbol] };
  });
  return { pf, valued: rated, summary, mood };
}

// ---------- render ----------
function render() {
  const d = derive();
  renderKpis(d);
  renderYearly(d);
  renderRealizedBySymbol(d);
  renderHoldings(d);
  renderNews(d);
  renderEvents(d);
  renderTxns(d);
  window.__last = d;
  if (!$('#tab-dashboard').hidden) drawCharts();
}

function emptyState() {
  return `<div class="card empty"><h2>No transactions yet</h2>
    <p>Import the activity CSV from your Chase Self-Directed Investing account, or try the app with sample data first.</p>
    <div class="row"><button class="btn" data-go="transactions">Import from Chase</button>
    <button class="btn ghost" data-sample>Load sample data</button></div></div>`;
}

function renderKpis({ summary, valued }) {
  if (!txns.length) { $('#kpis').innerHTML = emptyState(); $('#kpis').style.display = 'block'; return; }
  $('#kpis').style.display = '';
  const t = summary.totals;
  const thisYear = summary.rows[summary.rows.length - 1];
  const dayChange = valued.reduce((s, p) => s + (p.quote?.d ? p.quote.d * p.quantity : 0), 0);
  const tiles = [
    ['Market value', usd(t.marketValue || t.openCost), t.missingPrices ? `${t.missingPrices} holding(s) without a live price` : `Cost basis ${usd(t.openCost)}`],
    ["Today's change", usd(dayChange, true), market.loadedAt ? 'as of ' + market.loadedAt.toLocaleTimeString() : 'add API key for live prices', dayChange],
    ['Total P&L (till date)', usd(t.totalPnl, true), pct(t.totalReturnPct) + ' on total invested', t.totalPnl],
    ['Unrealized (open)', usd(t.unrealized, true), t.openCost ? pct(t.unrealized / t.openCost) + ' on cost' : '', t.unrealized],
    ['Realized gains', usd(t.realizedGain, true), `Dividends ${usd(t.income)} · Fees ${usd(t.fees)}`, t.realizedGain],
    [`${thisYear.year} net (realized)`, usd(thisYear.net, true), `Bought ${usd(thisYear.invested)} this year`, thisYear.net],
  ];
  $('#kpis').innerHTML = tiles.map(([label, value, delta, sign]) =>
    `<div class="kpi"><div class="label">${label}</div><div class="value ${sign != null ? cls(sign) : ''}">${value}</div><div class="delta">${esc(delta)}</div></div>`).join('');
}

function renderYearly({ summary }) {
  const cur = new Date().getFullYear();
  const head = '<tr><th>Year</th><th>Bought</th><th>Sold (proceeds)</th><th>Short-term gain</th><th>Long-term gain</th><th>Dividends &amp; interest</th><th>Fees</th><th>Net realized P&amp;L</th><th>Unrealized</th><th>Total P&amp;L</th></tr>';
  const row = (r, unreal, label = r.year) => `<tr${label === 'Till date' ? ' class="total"' : ''}><td>${label}</td><td>${usd(r.invested)}</td><td>${usd(r.proceeds)}</td>
    <td class="${cls(r.shortTerm)}">${usd(r.shortTerm, true)}</td><td class="${cls(r.longTerm)}">${usd(r.longTerm, true)}</td>
    <td>${usd(r.income)}</td><td>${r.fees ? usd(-r.fees) : usd(0)}</td><td class="${cls(r.net)}"><b>${usd(r.net, true)}</b></td>
    <td class="${cls(unreal)}">${unreal == null ? '' : usd(unreal, true)}</td>
    <td class="${cls(r.net + (unreal || 0))}"><b>${usd(r.net + (unreal || 0), true)}</b></td></tr>`;
  const body = summary.rows.map((r) => row(r, r.year === cur ? summary.totals.unrealized : null)).join('');
  $('#yearly-table').innerHTML = txns.length ? head + body + row(summary.totals, summary.totals.unrealized, 'Till date') : '';
}

function renderRealizedBySymbol({ pf }) {
  const by = {};
  for (const r of pf.realized) {
    const x = (by[r.symbol] ||= { symbol: r.symbol, qty: 0, cost: 0, proceeds: 0, gain: 0 });
    x.qty += r.quantity; x.cost += r.cost; x.proceeds += r.proceeds; x.gain += r.gain;
  }
  for (const i of pf.income) if (i.symbol) { (by[i.symbol] ||= { symbol: i.symbol, qty: 0, cost: 0, proceeds: 0, gain: 0 }).div = (by[i.symbol].div || 0) + i.amount; }
  const rows = Object.values(by).sort((a, b) => (b.gain + (b.div || 0)) - (a.gain + (a.div || 0)));
  const el = $('#realized-table');
  if (!rows.length) { el.innerHTML = '<tr><td class="left">Nothing sold yet.</td></tr>'; return; }
  el.innerHTML = '<tr><th>Stock</th><th>Shares sold</th><th>Cost</th><th>Proceeds</th><th>Realized gain</th><th>Dividends</th><th>Return</th></tr>' +
    rows.map((r) => `<tr><td class="sym">${esc(r.symbol)}</td><td>${r.qty ? qty(r.qty) : '—'}</td><td>${r.qty ? usd(r.cost) : '—'}</td><td>${r.qty ? usd(r.proceeds) : '—'}</td>
      <td class="${cls(r.gain)}">${r.qty ? usd(r.gain, true) : '—'}</td><td>${usd(r.div || 0)}</td><td class="${cls(r.gain)}">${r.cost ? pct(r.gain / r.cost) : '—'}</td></tr>`).join('');
}

function renderHoldings({ valued, mood }) {
  $('#mood').innerHTML = `<div><div class="sub" style="margin:0">Market mood</div><div class="big">${moodLabel(mood)}</div></div>
    <div class="sub" style="margin:0;flex:1;min-width:240px">Based on the S&amp;P 500 (SPY) 3- and 6-month trend and the tone of today's market headlines.
    ${market.spy?.quote ? `SPY ${usd(market.spy.quote.c)} (<span class="${cls(market.spy.quote.dp)}">${pct(market.spy.quote.dp / 100)}</span> today).` : ''}</div>`;
  if (!valued.length) { $('#holdings-table').innerHTML = `<tr><td class="left">${txns.length ? 'No open positions.' : 'Import transactions to see your holdings.'}</td></tr>`; return; }
  const head = '<tr><th>Stock</th><th>Shares</th><th>Avg cost</th><th>Price</th><th>Today</th><th>Value</th><th>Gain / loss</th><th>Weight</th><th class="left">Rating</th><th class="left">Signal</th><th class="left">Note</th></tr>';
  $('#holdings-table').innerHTML = head + valued.map((p) => {
    const r = p.rating;
    const name = p.profile?.name ? `<small title="${esc(p.profile.name)}">${esc(p.profile.name)}</small>` : '';
    const breakdown = r.parts.map((x) => `${x.key}: ${Math.round(x.score)}`).join(' · ');
    return `<tr>
      <td class="sym">${esc(p.symbol)}${name}</td>
      <td data-label="Shares">${qty(p.quantity)}</td><td data-label="Avg cost">${usd(p.avgCost)}</td><td data-label="Price">${usd(p.price)}</td>
      <td data-label="Today" class="${cls(p.quote?.dp)}">${p.quote?.c ? pct(p.quote.dp / 100) : '—'}</td>
      <td data-label="Value">${usd(p.value)}</td>
      <td data-label="Gain / loss" class="${cls(p.unrealized)}">${usd(p.unrealized, true)}<br><small>${pct(p.unrealizedPct)}</small></td>
      <td data-label="Weight">${(p.weight * 100).toFixed(1)}%</td>
      <td data-label="Rating" class="left" title="${esc(breakdown)}">${r.score == null ? '—' : `<span class="score"><span class="grade">${r.grade}</span><span class="bar"><i style="width:${r.score}%"></i></span>${r.score}</span>`}</td>
      <td data-label="Signal" class="left"><span class="badge ${r.action === 'N/A' ? 'NA' : r.action}">${r.action === 'BUY' ? '▲' : r.action === 'SELL' ? '▼' : r.action === 'HOLD' ? '●' : ''} ${r.action}</span></td>
      <td data-label="Note" class="note">${esc(r.note)}</td></tr>`;
  }).join('');
}

function renderNews({ valued }) {
  const sel = $('#news-symbol');
  const current = sel.value || 'ALL';
  sel.innerHTML = `<option value="ALL">All my stocks</option><option value="MARKET">Market headlines</option>` +
    valued.map((p) => `<option>${esc(p.symbol)}</option>`).join('');
  sel.value = [...sel.options].some((o) => o.value === current) ? current : 'ALL';
  let items;
  if (sel.value === 'MARKET') items = market.marketNews.map((n) => ({ ...n, sym: 'Market' }));
  else {
    const syms = sel.value === 'ALL' ? valued.map((p) => p.symbol) : [sel.value];
    items = syms.flatMap((s) => (market.news[s] || []).slice(0, sel.value === 'ALL' ? 6 : 40).map((n) => ({ ...n, sym: s })));
  }
  items.sort((a, b) => b.datetime - a.datetime);
  const seen = new Set();
  items = items.filter((n) => !seen.has(n.url) && seen.add(n.url)).slice(0, 60);
  $('#news-list').innerHTML = items.length ? items.map((n) => `<article class="news-item">
      <div class="meta"><span class="tag">${esc(n.sym)}</span><span>${esc(n.source)}</span><span>${new Date(n.datetime * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div>
      <a href="${esc(/^https?:/.test(n.url) ? n.url : '#')}" target="_blank" rel="noopener noreferrer">${esc(n.headline)}</a>
      ${n.summary ? `<p>${esc(n.summary)}</p>` : ''}</article>`).join('')
    : `<div class="card empty">${apiKey ? 'No news loaded yet. Click <b>Refresh prices</b>.' : 'Add your free Finnhub API key in <b>Settings</b> to see the latest news.'}</div>`;
}
$('#news-symbol').addEventListener('change', () => renderNews(derive()));

function renderEvents({ valued }) {
  const today = new Date().toISOString().slice(0, 10);
  const held = new Set(valued.map((p) => p.symbol));
  const earnings = market.earnings.filter((e) => held.has(e.symbol) && e.date >= today).map((e) => ({
    date: e.date, kind: 'earnings',
    time: { bmo: 'Before market open', amc: 'After market close', dmh: 'During market hours' }[e.hour] || '',
    title: `${e.symbol} earnings (Q${e.quarter} ${e.year})`,
    why: [e.epsEstimate != null ? `EPS estimate $${Number(e.epsEstimate).toFixed(2)}` : '',
      e.revenueEstimate ? `revenue estimate $${compact(e.revenueEstimate)}` : '',
      'Stocks often move sharply on results and guidance.'].filter(Boolean).join(' · '),
  }));
  const all = [...earnings, ...upcomingMacro(new Date(), 120)].sort((a, b) => a.date.localeCompare(b.date));
  const kindLabel = { earnings: 'EARNINGS', macro: 'ECONOMY', fed: 'FED' };
  $('#event-list').innerHTML = all.map((e) => {
    const days = Math.round((Date.parse(e.date + 'T12:00:00') - Date.now()) / 86400000);
    const rel = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    return `<div class="event"><div class="when">${fmtDate(e.date).replace(/, \d{4}$/, '')}<small>${rel}</small></div>
      <div><div class="what"><span class="kind ${e.kind}">${kindLabel[e.kind]}</span>${esc(e.title)}</div>
      <div class="why">${e.time ? esc(e.time) + ' · ' : ''}${esc(e.why)}</div></div></div>`;
  }).join('') + (apiKey ? '' : '<p class="sub small">Add a Finnhub key in Settings to include earnings dates for your stocks.</p>');
}

function renderTxns({ pf }) {
  $('#txn-count').textContent = `(${txns.length})`;
  $('#warnings').innerHTML = pf.warnings.length
    ? `<div class="alert warn"><b>Check these:</b><br>${pf.warnings.slice(0, 10).map(esc).join('<br>')}${pf.warnings.length > 10 ? `<br>…and ${pf.warnings.length - 10} more` : ''}</div>` : '';
  const sorted = [...txns].sort((a, b) => b.date.localeCompare(a.date));
  $('#txn-table').innerHTML = txns.length ? '<tr><th>Date</th><th class="left">Type</th><th class="left">Ticker</th><th>Shares</th><th>Price</th><th>Fees</th><th>Amount</th><th class="left">Note</th><th></th></tr>' +
    sorted.map((t) => `<tr><td>${t.date}</td><td class="left">${t.type}</td><td class="left sym">${esc(t.symbol)}</td>
      <td>${t.quantity ? qty(t.quantity) : ''}</td><td>${t.price ? usd(t.price) : ''}</td><td>${t.fees ? usd(t.fees) : ''}</td>
      <td>${t.amount != null ? usd(t.amount) : ''}</td><td class="left" style="white-space:normal;max-width:260px;color:var(--ink-2)">${esc(t.note)}</td>
      <td><button class="del" data-del="${esc(t.id)}" title="Delete" aria-label="Delete transaction">×</button></td></tr>`).join('')
    : '<tr><td class="left">No transactions yet.</td></tr>';
}

// ---------- charts ----------
function drawCharts() {
  if (!window.Chart || !window.__last) return;
  const { summary, valued } = window.__last;
  const ink2 = cssVar('--ink-2'), grid = cssVar('--grid'), pos = cssVar('--pos'), neg = cssVar('--neg'), surface = cssVar('--surface');
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = ink2;
  const money = (v) => (Math.abs(v) >= 1000 ? '$' + (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : '$' + v);
  const cur = new Date().getFullYear();

  const years = summary.rows.map((r) => String(r.year));
  const realized = summary.rows.map((r) => r.net);
  const unreal = summary.rows.map((r) => (r.year === cur ? summary.totals.unrealized : 0));
  const fade = (c) => c + '73';
  charts.yearly?.destroy();
  charts.yearly = new Chart($('#chart-yearly'), {
    type: 'bar',
    data: {
      labels: years,
      datasets: [
        { label: 'Realized + dividends', data: realized, backgroundColor: realized.map((v) => (v >= 0 ? pos : neg)), borderRadius: 4, borderSkipped: false, borderColor: surface, borderWidth: 1, maxBarThickness: 56 },
        { label: 'Unrealized (open positions)', data: unreal, backgroundColor: unreal.map((v) => fade(v >= 0 ? pos : neg)), borderRadius: 4, borderSkipped: false, borderColor: surface, borderWidth: 1, maxBarThickness: 56 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, grid: { display: false }, border: { color: cssVar('--axis') } },
        y: { stacked: true, grid: { color: grid }, border: { display: false }, ticks: { callback: money } },
      },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, useBorderRadius: true, borderRadius: 3,
          generateLabels: (c) => c.data.datasets.map((ds, i) => ({ text: ds.label, fillStyle: i ? fade(pos) : pos, strokeStyle: 'transparent', datasetIndex: i, hidden: !c.isDatasetVisible(i), fontColor: ink2 })) } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${usd(ctx.raw, true)}` } },
      },
    },
  });

  const items = valued.map((p) => ({ s: p.symbol, v: p.value ?? p.cost })).sort((a, b) => b.v - a.v);
  const top = items.slice(0, 10);
  if (items.length > 10) top.push({ s: 'Other', v: items.slice(10).reduce((a, b) => a + b.v, 0) });
  const total = items.reduce((a, b) => a + b.v, 0);
  charts.alloc?.destroy();
  charts.alloc = new Chart($('#chart-alloc'), {
    type: 'bar',
    data: { labels: top.map((x) => x.s), datasets: [{ label: 'Market value', data: top.map((x) => x.v), backgroundColor: cssVar('--accent'), borderRadius: 4, borderSkipped: false, maxBarThickness: 22 }] },
    options: {
      indexAxis: 'y', maintainAspectRatio: false,
      scales: { x: { grid: { color: grid }, border: { display: false }, ticks: { callback: money } }, y: { grid: { display: false } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${usd(ctx.raw)} (${total ? ((ctx.raw / total) * 100).toFixed(1) : 0}%)` } } },
    },
  });
}

// ---------- market data ----------
let loading = false;
async function refreshMarket(force = false) {
  if (!apiKey) { showBanner('Add your free <a href="https://finnhub.io/register" target="_blank" rel="noopener">Finnhub API key</a> in <b>Settings</b> to load live prices, ratings, news and earnings dates.'); return; }
  if (loading) return;
  loading = true;
  $('#refresh').disabled = true;
  showBanner('');
  const fh = new Finnhub(apiKey);
  const syms = computePortfolio(txns).positions.map((p) => p.symbol);
  const jobs = [
    ...syms.flatMap((s) => [
      () => fh.quote(s, { force }).then((v) => { market.quotes[s] = v; }),
      () => fh.metrics(s).then((v) => { market.metrics[s] = v; }),
      () => fh.recommendation(s).then((v) => { market.recs[s] = v; }),
      () => fh.companyNews(s).then((v) => { market.news[s] = Array.isArray(v) ? v : []; }),
      () => fh.profile(s).then((v) => { market.profiles[s] = v; }),
      () => fh.earnings(s).then((v) => {
        market.earnings = market.earnings.filter((e) => e.symbol !== s).concat(v?.earningsCalendar || []);
      }),
    ]),
    () => fh.quote('SPY', { force }).then((v) => { (market.spy ||= {}).quote = v; }),
    () => fh.metrics('SPY').then((v) => { (market.spy ||= {}).metric = v?.metric; }),
    () => fh.marketNews().then((v) => { market.marketNews = Array.isArray(v) ? v : []; }),
  ];
  let done = 0, firstError = null;
  setStatus(`Loading 0/${jobs.length}…`);
  let lastPaint = 0;
  await Promise.all(jobs.map((j) => j().catch((e) => { firstError ||= e; }).finally(() => {
    done++;
    setStatus(`Loading ${done}/${jobs.length}…`);
    if (Date.now() - lastPaint > 1500) { lastPaint = Date.now(); render(); }
  })));
  market.loadedAt = new Date();
  setStatus(`Updated ${market.loadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  if (firstError) showBanner(esc(firstError.message), 'err');
  loading = false;
  $('#refresh').disabled = false;
  render();
}
$('#refresh').addEventListener('click', () => refreshMarket(true));

// ---------- transactions: import/add/delete ----------
function saveTxns(list) {
  txns = list.map(normalizeTxn);
  store.set('txns', txns);
  render();
}

$('#csv-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { txns: rows, skipped } = importBrokerCsv(await file.text());
    const replace = $('#csv-replace').checked;
    // Skip rows already imported (same date/type/symbol/qty/price/amount) so re-importing overlapping ranges is safe.
    const key = (t) => [t.date, t.type, t.symbol, +(+t.quantity).toFixed(6), +(+t.price).toFixed(4), t.amount == null ? '' : +(+t.amount).toFixed(2)].join('|');
    const existing = new Set((replace ? [] : txns).map(key));
    const fresh = rows.filter((t) => !existing.has(key(t)));
    saveTxns([...(replace ? [] : txns), ...fresh]);
    $('#import-result').innerHTML = `Imported <b>${fresh.length}</b> transaction(s)` +
      (rows.length - fresh.length ? `, ${rows.length - fresh.length} duplicate(s) skipped` : '') +
      (skipped.length ? `. ${skipped.length} row(s) ignored (e.g. line ${skipped[0].line}: ${esc(skipped[0].reason)}).` : '.');
    refreshMarket();
  } catch (err) {
    $('#import-result').innerHTML = `<span class="down">${esc(err.message)}</span>`;
  }
});

$('#txn-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  if (['BUY', 'SELL', 'SPLIT'].includes(f.type) && (!f.symbol || !Number(f.quantity))) { alert('Trades need a ticker and number of shares.'); return; }
  saveTxns([...txns, { ...f, amount: f.amount === '' ? null : f.amount }]);
  e.target.reset();
  refreshMarket();
});

$('#txn-table').addEventListener('click', (e) => {
  const id = e.target.dataset?.del;
  if (id && confirm('Delete this transaction?')) saveTxns(txns.filter((t) => t.id !== id));
});

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 10);
$('#export-csv').addEventListener('click', () => download(`transactions-${stamp()}.csv`, toCsv(txns), 'text/csv'));
$('#export-json').addEventListener('click', () => download(`portfolio-backup-${stamp()}.json`, JSON.stringify({ version: 1, txns }, null, 2), 'application/json'));
$('#import-json').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.txns;
    if (!Array.isArray(list)) throw new Error('Not a backup file');
    if (confirm(`Replace your ${txns.length} transactions with ${list.length} from the backup?`)) { saveTxns(list); refreshMarket(); }
  } catch (err) { alert('Could not read backup: ' + err.message); }
});

// ---------- settings ----------
$('#api-key').value = apiKey;
$('#key-form').addEventListener('submit', (e) => {
  e.preventDefault();
  apiKey = $('#api-key').value.trim();
  store.set('key', apiKey);
  setStatus(apiKey ? 'Key saved' : 'Key removed');
  refreshMarket(true);
});
async function loadSample() {
  if (txns.length && !confirm('Replace your transactions with the sample data?')) return;
  const text = await (await fetch('sample/sample-transactions.csv')).text();
  saveTxns(importBrokerCsv(text).txns);
  selectTab('dashboard');
  refreshMarket();
}
$('#load-sample').addEventListener('click', loadSample);
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-sample]')) loadSample();
  const go = e.target.closest('[data-go]');
  if (go) selectTab(go.dataset.go);
});
$('#clear-cache').addEventListener('click', () => { clearMarketCache(); setStatus('Cache cleared'); });
$('#clear-all').addEventListener('click', () => {
  if (!confirm('Delete all transactions and your API key from this browser? Export a backup first if you need one.')) return;
  store.del('txns'); store.del('key'); clearMarketCache();
  txns = []; apiKey = ''; $('#api-key').value = '';
  Object.assign(market, { quotes: {}, metrics: {}, recs: {}, news: {}, profiles: {}, earnings: [], marketNews: [], spy: null, loadedAt: null });
  render();
});

// ---------- boot ----------
let startTab = 'dashboard';
try { startTab = sessionStorage.getItem('pt:tab') || 'dashboard'; } catch { /* ignore */ }
render();
selectTab(startTab);
window.addEventListener('load', drawCharts); // Chart.js loads with defer
refreshMarket();
setInterval(() => { if (document.visibilityState === 'visible' && apiKey) refreshMarket(true); }, 5 * 60000);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computePortfolio, valuePositions, yearlySummary } from '../js/portfolio.js';
import { importBrokerCsv } from '../js/csv.js';
import { rateStock, headlineSentiment } from '../js/rating.js';

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('FIFO realized gains split across lots and years', () => {
  const pf = computePortfolio([
    { date: '2025-01-02', type: 'BUY', symbol: 'abc', quantity: 10, price: 10, fees: 0 },
    { date: '2025-06-01', type: 'BUY', symbol: 'ABC', quantity: 10, price: 20, fees: 0 },
    { date: '2026-03-01', type: 'SELL', symbol: 'ABC', quantity: 15, price: 30, fees: 0 },
  ]);
  near(pf.realized.reduce((s, r) => s + r.gain, 0), 10 * 20 + 5 * 10);
  assert.equal(pf.realized[0].term, 'long');   // lot 1 held > 1 year
  assert.equal(pf.realized[1].term, 'short');  // lot 2 held < 1 year
  assert.equal(pf.positions[0].quantity, 5);
  near(pf.positions[0].avgCost, 20);
});

test('fees go into cost basis and reduce proceeds', () => {
  const pf = computePortfolio([
    { date: '2025-01-02', type: 'BUY', symbol: 'X', quantity: 10, price: 10, fees: 5 },
    { date: '2025-02-02', type: 'SELL', symbol: 'X', quantity: 10, price: 11, fees: 5 },
  ]);
  near(pf.realized[0].gain, 110 - 5 - 105);
});

test('split keeps total cost and multiplies shares', () => {
  const pf = computePortfolio([
    { date: '2025-01-02', type: 'BUY', symbol: 'X', quantity: 10, price: 100 },
    { date: '2025-06-10', type: 'SPLIT', symbol: 'X', quantity: 90 }, // 10-for-1
  ]);
  near(pf.positions[0].quantity, 100);
  near(pf.positions[0].cost, 1000);
});

test('overselling is capped with a warning', () => {
  const pf = computePortfolio([
    { date: '2025-01-02', type: 'BUY', symbol: 'X', quantity: 1, price: 10 },
    { date: '2025-01-03', type: 'SELL', symbol: 'X', quantity: 2, price: 10 },
  ]);
  assert.equal(pf.warnings.length, 1);
  assert.equal(pf.positions.length, 0);
});

test('yearly summary and till-date totals', () => {
  const pf = computePortfolio([
    { date: '2025-01-02', type: 'BUY', symbol: 'X', quantity: 10, price: 10 },
    { date: '2025-05-02', type: 'DIVIDEND', symbol: 'X', amount: 3 },
    { date: '2025-12-02', type: 'SELL', symbol: 'X', quantity: 5, price: 12 },
  ]);
  const valued = valuePositions(pf.positions, { X: 20 });
  const s = yearlySummary(pf, valued, new Date('2026-06-01'));
  assert.deepEqual(s.rows.map((r) => r.year), [2025, 2026]);
  near(s.rows[0].net, 10 + 3);
  near(s.totals.unrealized, 5 * 20 - 50);
  near(s.totals.totalPnl, 13 + 50);
});

test('imports the Chase-style sample CSV', () => {
  const { txns, skipped } = importBrokerCsv(readFileSync(new URL('../sample/sample-transactions.csv', import.meta.url), 'utf8'));
  assert.equal(skipped.length, 0);
  assert.equal(txns.length, 25);
  const sell = txns.find((t) => t.type === 'SELL' && t.symbol === 'TSLA');
  assert.equal(sell.quantity, 8);
  assert.equal(txns.filter((t) => t.type === 'DIVIDEND').length, 7);
  assert.equal(txns.filter((t) => t.type === 'DEPOSIT').length, 3);
});

test('handles title rows, quotes, parentheses negatives and reinvestment', () => {
  const csv = 'Account Activity\n\n"Date","Action","Symbol","Description","Quantity","Price","Amount"\n' +
    '1/5/2025,"Reinvest Shares",KO,"COCA COLA, REINVEST",0.25,60,(15.00)\n' +
    '1/5/2025,Qualified Dividend,KO,"COCA COLA",,,15.00\n';
  const { txns } = importBrokerCsv(csv);
  assert.equal(txns[0].type, 'BUY');
  assert.equal(txns[0].amount, 15);
  assert.equal(txns[1].type, 'DIVIDEND');
});

test('rating maps strong signals to BUY and weak to SELL', () => {
  const strong = rateStock({ rec: { strongBuy: 20, buy: 10, hold: 2 }, ret13w: 15, ret26w: 30, price: 98, high52: 100, low52: 50, newsSentiment: 0.4 });
  assert.equal(strong.action, 'BUY');
  const weak = rateStock({ rec: { hold: 5, sell: 8, strongSell: 4 }, ret13w: -20, ret26w: -30, price: 52, high52: 100, low52: 50, newsSentiment: -0.4 });
  assert.equal(weak.action, 'SELL');
  const none = rateStock({});
  assert.equal(none.action, 'N/A');
});

test('a big position is not rated BUY (concentration)', () => {
  const r = rateStock({ rec: { strongBuy: 20, buy: 10 }, ret13w: 15, ret26w: 30, position: { weight: 0.4, unrealizedPct: 0.1 } });
  assert.equal(r.action, 'HOLD');
});

test('headline sentiment', () => {
  assert.ok(headlineSentiment(['Company beats estimates, stock surges']) > 0);
  assert.ok(headlineSentiment(['Shares plunge after earnings miss']) < 0);
  assert.equal(headlineSentiment([]), null);
});

test('money-market sweep trades are treated as cash, not investments', () => {
  const pf = computePortfolio([
    { date: '2026-01-02', type: 'BUY', symbol: 'MGXX', quantity: 5000, price: 1, note: 'JPMORGAN US GOVERNMENT MONEY MARKET FUND' },
    { date: '2026-01-03', type: 'SELL', symbol: 'MGXX', quantity: 5000, price: 1, note: 'JPMORGAN US GOVERNMENT MONEY MARKET FUND' },
    { date: '2026-01-04', type: 'BUY', symbol: 'AAPL', quantity: 1, price: 200, note: 'APPLE INC' },
  ]);
  assert.equal(pf.buys.length, 1);
  assert.equal(pf.realized.length, 0);
  assert.equal(pf.cashLike.count, 2);
});

test('each realized lot remembers its sale and buy date', () => {
  const pf = computePortfolio([
    { id: 'b1', date: '2025-01-02', type: 'BUY', symbol: 'X', quantity: 1, price: 10 },
    { id: 'b2', date: '2025-03-02', type: 'BUY', symbol: 'X', quantity: 1, price: 10 },
    { id: 's1', date: '2025-05-02', type: 'SELL', symbol: 'X', quantity: 2, price: 12 },
  ]);
  assert.deepEqual(pf.realized.map((r) => [r.saleId, r.boughtDate]), [['s1', '2025-01-02'], ['s1', '2025-03-02']]);
});

import { parseTax1099Csv, applyTaxDocs, isTax1099Csv } from '../js/tax.js';
const tax2024 = readFileSync(new URL('./fixtures/sample-1099-2024.csv', import.meta.url), 'utf8');

test('reads the Chase 1099 CSV: lots, wash sale, dividends', () => {
  assert.ok(isTax1099Csv(tax2024));
  const doc = parseTax1099Csv(tax2024, '2024-taxdocuments.csv');
  assert.equal(doc.year, 2024);
  assert.equal(doc.lots.length, 3);
  assert.deepEqual(doc.lots.map((l) => l.name), ['APPLE INC', 'EXAMPLE CORP', 'EXAMPLE CORP']);
  near(doc.lots[1].gain, 400 - 500 + 40); // wash-sale loss added back
  assert.equal(doc.lots[0].term, 'long');
  near(doc.dividends, 25); // ordinary + capital gain distributions
  assert.equal(doc.interest, 0);
});

test('a 1099 year replaces the activity-based numbers for that year only', () => {
  const pf = computePortfolio([
    { date: '2024-01-02', type: 'BUY', symbol: 'AAPL', quantity: 10, price: 150, note: 'APPLE INC' },
    { date: '2024-05-10', type: 'SELL', symbol: 'AAPL', quantity: 5, price: 999 },
    { date: '2024-07-01', type: 'DIVIDEND', symbol: 'AAPL', amount: 1 },
    { date: '2025-03-01', type: 'SELL', symbol: 'AAPL', quantity: 5, price: 200 },
  ]);
  const doc = parseTax1099Csv(tax2024, '2024.csv');
  const merged = applyTaxDocs(pf, { 2024: doc }, { 'APPLE INC': 'AAPL' });
  const s = yearlySummary(merged, [], new Date('2025-12-01'));
  const y24 = s.rows.find((r) => r.year === 2024), y25 = s.rows.find((r) => r.year === 2025);
  assert.equal(y24.source, '1099');
  near(y24.realizedGain, 150 - 60 + 30);
  near(y24.income, 25);
  assert.equal(y25.source, 'Activity');
  near(y25.realizedGain, 5 * 200 - 5 * 150);
  assert.ok(merged.realized.some((r) => r.symbol === 'AAPL' && r.source === '1099'));
});

test('rejects a tax file whose name and dates disagree', () => {
  assert.throws(() => parseTax1099Csv(tax2024, '2023 taxes.csv'), /another year/);
});

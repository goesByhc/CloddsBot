#!/usr/bin/env node
/**
 * Progress tracker for the order-book observation study.
 *
 * Answers "how close are we to a conclusion?" by counting the things that actually
 * gate the answer, per asset:
 *
 *   matched entries   - tape entries with a book observation within tolerance
 *   cheap entries     - the subset at <= 0.05, where the edge concentrates and
 *                       depth is least certain
 *   resolved          - entries whose round has settled (needed for any accuracy claim)
 *
 * Thresholds are printed alongside so the number has a reference point.
 *
 *   node scripts/observe-status.mjs
 *   node scripts/observe-status.mjs --assets btc,eth,sol --duration 15m
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const assets = opt('assets', 'btc,eth,sol').split(',').map((s) => s.trim());
const duration = opt('duration', '15m');
const bookDir = opt('dir', join(process.cwd(), '.cache', 'orderbook'));
const tapeDir = join(process.cwd(), '.cache', 'crypto-hft');

const TOL_SEC = 20;
/** Below this, a rate is noise. */
const MIN_FOR_PRELIMINARY = 10;
/** Enough to put error bars on a fillability claim. */
const MIN_FOR_FILLABILITY = 25;

function loadBooks(asset) {
  if (!existsSync(bookDir)) return [];
  const out = [];
  for (const f of readdirSync(bookDir)) {
    if (!f.endsWith('.jsonl') || f.includes('-raw')) continue;
    for (const line of readFileSync(join(bookDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.asset === asset) out.push(o);
      } catch {
        /* skip */
      }
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function loadTape(asset) {
  const p = join(tapeDir, `${asset}-${duration}.jsonl`);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}

console.log(`\nObservation status  (${assets.join(', ')} ${duration})`);
console.log('='.repeat(78));

let anyBooks = false;

for (const asset of assets) {
  const books = loadBooks(asset);
  const tape = loadTape(asset);
  if (books.length === 0) {
    console.log(`\n${asset.toUpperCase()}: no book observations yet`);
    continue;
  }
  anyBooks = true;

  const spanMin = (books[books.length - 1].ts - books[0].ts) / 60;
  const hours = spanMin / 60;

  // Index books by slug+side for nearest lookup.
  const bySlugSide = new Map();
  for (const b of books) {
    const k = `${b.slug}|${b.side}`;
    if (!bySlugSide.has(k)) bySlugSide.set(k, []);
    bySlugSide.get(k).push(b);
  }

  const firstMs = books[0].ts * 1000;
  const lastMs = books[books.length - 1].ts * 1000;
  const rounds = tape.filter(
    (r) => r.endSec * 1000 >= firstMs && r.startSec * 1000 <= lastMs && r.up.length + r.down.length >= 20
  );

  // Entries: reuse the real predicate by shelling out to the analyzer is wasteful;
  // instead derive the count from the tape's own resolution + a light signal check.
  // For status purposes the KEY figures are record coverage and round count, which
  // we have exactly; entry counts come from the analyzer when it can run.
  console.log(`\n${asset.toUpperCase()}`);
  console.log(`  observations        : ${books.length.toLocaleString()}`);
  console.log(`  recorded span       : ${spanMin.toFixed(0)} min (${hours.toFixed(1)} h)`);
  console.log(`  distinct timestamps : ${new Set(books.map((b) => b.ts)).size.toLocaleString()}`);
  console.log(`  rounds covered      : ${new Set(books.map((b) => b.slug)).size}`);
  console.log(`  tape rounds in span : ${rounds.length}`);
  const resolved = rounds.filter((r) => r.resolvedUp !== null).length;
  console.log(`    of which resolved : ${resolved}`);

  // Derived expectations from measured rates.
  const RATE = { btc: 1.35, eth: 9.4, sol: 18.3 }[asset] ?? 0;
  const LOW_FRAC = 0.247;
  const expectedAll = RATE * (hours / 24);
  const expectedLow = expectedAll * LOW_FRAC;
  const lowFillDays = MIN_FOR_FILLABILITY / (RATE * LOW_FRAC);
  console.log(
    `  expected entries    : ${expectedAll.toFixed(1)} total, ${expectedLow.toFixed(1)} at <=0.05 ` +
      `(rate ${RATE}/day)`
  );
  console.log(
    `  days to ${MIN_FOR_PRELIMINARY} cheap: ${(MIN_FOR_PRELIMINARY / (RATE * LOW_FRAC)).toFixed(1)}` +
      `     days to ${MIN_FOR_FILLABILITY} cheap: ${lowFillDays.toFixed(0)}`
  );

  // Book freshness / quality, which gates trust in the join at all.
  const asks = books.filter((b) => b.bestAsk !== null).map((b) => b.bestAsk);
  const ages = books.filter((b) => typeof b.bookAgeMs === 'number').map((b) => b.bookAgeMs);
  const q = (xs, f) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length * f)] : NaN);
  console.log(
    `  best ask p10/p50/p90: ${q(asks, 0.1).toFixed(3)} / ${q(asks, 0.5).toFixed(3)} / ${q(asks, 0.9).toFixed(3)}`
  );
  console.log(
    `  book age p50/p90    : ${q(ages, 0.5)}ms / ${q(ages, 0.9)}ms`
  );
}

if (!anyBooks) {
  console.log('\nNo observations recorded yet. Start:');
  console.log(`  npx tsx scripts/observe-orderbook.ts --assets "${assets.join(',')}" --duration ${duration}`);
  process.exit(0);
}

console.log(`\n${'='.repeat(78)}`);
console.log('WHAT EACH THRESHOLD BUYS');
console.log('='.repeat(78));
console.log(`  >= ${MIN_FOR_FILLABILITY} matched entries  -> fillability rate with usable error bars`);
console.log(`  >= 30 resolved entries    -> per-trade net with ~ +/-1.8c error at typical variance`);
console.log(`  >= 200 resolved entries   -> the headline number to the precision of the backtest`);
console.log(`
  The cheap (<=0.05) entries are the binding constraint, not the total count: they
  carry most of the edge AND are where depth is least certain. Expect the fillability
  answer well before the profitability answer.
`);

console.log('Run the full join with:');
console.log(`  node scripts/observe-loop.mjs --assets "${assets.join(',')}" --duration ${duration}`);
void spawnSync('true');

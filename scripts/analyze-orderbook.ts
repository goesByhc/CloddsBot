/**
 * Analyze recorded order books against the trade tape.
 *
 * THE QUESTION
 * ------------
 * The tick backtester fills at the traded print. Its entries cluster at low prices
 * (median ~0.26, a quarter at or below 0.05), and it assumes you could buy there.
 * Order-book history does not exist, so `scripts/observe-orderbook.ts` records the
 * live book forward. This joins the two and answers, per entry:
 *
 *   1. Could that price have been bought?  (tape price vs live best ask)
 *   2. In what size?                       (live depth at that price)
 *   3. Was the book stale?                 (age at observation)
 *
 * It also computes the book-implied probability versus the realized settlement
 * rate, which is a separate check on whether these markets are efficient.
 *
 *   npx tsx scripts/analyze-orderbook.ts --asset btc --duration 15m
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  collectEntries,
  loadSpotSeries,
  DEFAULT_BT_CONFIG,
  type SpotPoint,
  type TickRound,
} from '../src/strategies/crypto-hft/backtest';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SPOT_SYMBOL: Record<string, string> = { btc: 'BTCUSDT', eth: 'ETHUSDT', sol: 'SOLUSDT' };

interface BookObs {
  ts: number;
  slug: string;
  asset: string;
  roundAgeSec: number;
  side: 'up' | 'down';
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  mid: number | null;
  askDepth: number;
  askDepthAt005: number;
  askDepthAt010: number;
  askDepthAt026: number;
  askDepthAt040: number;
  askDepthAt050: number;
  bookAgeMs: number | null;
  lastTradePrice: number | null;
  error?: string;
}

function loadBooks(dir: string, asset: string): BookObs[] {
  if (!existsSync(dir)) return [];
  const out: BookObs[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl') || f.includes('-raw')) continue;
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as BookObs;
        if (o.asset === asset) out.push(o);
      } catch {
        /* skip */
      }
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)))];
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

async function main() {
  const asset = arg('asset', 'btc').toLowerCase();
  const duration = arg('duration', '15m');
  const strategy = arg('strategy', 'momentum');
  const dir = arg('dir', join(process.cwd(), '.cache', 'orderbook'));

  const books = loadBooks(dir, asset);
  console.log(`\n${asset.toUpperCase()} ${duration}  strategy=${strategy}`);
  console.log(`book observations loaded: ${books.length.toLocaleString()}`);
  if (books.length === 0) {
    console.error(`\nNo book observations for ${asset} in ${dir}.`);
    console.error(`Start the recorder:  npx tsx scripts/observe-orderbook.ts --assets "${asset}" --duration ${duration}`);
    process.exit(2);
  }
  const spanMs = books[books.length - 1].ts * 1000 - books[0].ts * 1000;
  const spanMin = spanMs / 60000;
  console.log(
    `observation window: ${spanMin.toFixed(1)} minutes  ` +
      `(${new Date(books[0].ts * 1000).toISOString().slice(11, 16)} .. ` +
      `${new Date(books[books.length - 1].ts * 1000).toISOString().slice(11, 16)} UTC)`
  );
  if (spanMin < 2) {
    console.log(`\n  Only ${spanMin.toFixed(1)} min recorded. The recorder needs to run for a`);
    console.log(`  while before there is enough to join. This exits rather than guess.`);
    return;
  }

  // Index books by slug+side for O(1) nearest lookup.
  const bySlugSide = new Map<string, BookObs[]>();
  for (const b of books) {
    const k = `${b.slug}|${b.side}`;
    let arr = bySlugSide.get(k);
    if (!arr) {
      arr = [];
      bySlugSide.set(k, arr);
    }
    arr.push(b);
  }

  function nearest(slug: string, side: 'up' | 'down', tSec: number, tolSec = 20): BookObs | null {
    const arr = bySlugSide.get(`${slug}|${side}`);
    if (!arr) return null;
    let best: BookObs | null = null;
    let bestD = Infinity;
    for (const b of arr) {
      const d = Math.abs(b.ts - tSec);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return bestD <= tolSec ? best : null;
  }

  // ── tape ──
  const tapePath = join(process.cwd(), '.cache', 'crypto-hft', `${asset}-${duration}.jsonl`);
  if (!existsSync(tapePath)) {
    console.error(`no tape cache at ${tapePath}`);
    process.exit(2);
  }
  const all: TickRound[] = [];
  for (const line of readFileSync(tapePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      all.push(JSON.parse(line) as TickRound);
    } catch {
      /* skip */
    }
  }
  all.sort((a, b) => a.startSec - b.startSec);

  // Rounds that OVERLAP the observation window.
  //
  // Requiring a round to sit entirely inside the window is impossible whenever the
  // window is shorter than one round (a 15-minute round can never fit inside a
  // 6-minute recording), which made this silently analyse nothing. Overlap is the
  // correct test; the per-entry join still requires an observation within
  // `tolSec` of the entry, so partial coverage cannot fabricate a match.
  const firstMs = books[0].ts * 1000;
  const lastMs = books[books.length - 1].ts * 1000;
  const rounds = all.filter(
    (r) =>
      r.endSec * 1000 >= firstMs &&
      r.startSec * 1000 <= lastMs &&
      r.up.length + r.down.length >= 20
  );
  console.log(`tape rounds overlapping that window: ${rounds.length}`);

  if (rounds.length === 0) {
    console.log(`\nNo overlapping rounds yet. Let the recorder run longer, then re-run.`);
    return;
  }

  const spot: SpotPoint[] = await loadSpotSeries(
    SPOT_SYMBOL[asset],
    rounds[0].startSec,
    rounds[rounds.length - 1].endSec,
    join(process.cwd(), '.cache', 'crypto-hft')
  );
  const entries = collectEntries(rounds, { ...DEFAULT_BT_CONFIG, strategy: strategy as never, spot });
  console.log(`entries from the tape in that window: ${entries.length}`);

  // ── join ──
  let matched = 0;
  let tapeBelowBestAsk = 0; // entry price NOT reachable as a taker
  let tapeAtOrAboveBestAsk = 0;
  let withDepth = 0;
  const askAtEntry: number[] = [];
  const gapToAskCents: number[] = [];
  const depthAtEntry: number[] = [];
  const bookAges: number[] = [];
  const spreads: number[] = [];
  const bookMidVsTape: number[] = [];
  const notionalAvailable: number[] = [];

  // Book-implied probability vs realized outcome.
  const bookImplied: number[] = [];
  const realized: number[] = [];

  for (const e of entries) {
    const b = nearest(e.roundSlug, e.direction, e.t);
    if (!b || b.bestAsk === null) continue;
    matched++;
    askAtEntry.push(b.bestAsk);
    gapToAskCents.push((b.bestAsk - e.entryPrice) * 100);
    if (b.bestAsk <= e.entryPrice + 1e-9) tapeAtOrAboveBestAsk++;
    else tapeBelowBestAsk++;
    if (b.bookAgeMs !== null) bookAges.push(b.bookAgeMs);
    if (b.spread !== null) spreads.push(b.spread);
    if (b.mid !== null) bookMidVsTape.push((b.mid - e.entryPrice) * 100);

    // Depth available at or below the tape's entry price.
    let depth = 0;
    if (e.entryPrice <= 0.05) depth = b.askDepthAt005;
    else if (e.entryPrice <= 0.1) depth = b.askDepthAt010;
    else if (e.entryPrice <= 0.26) depth = b.askDepthAt026;
    else if (e.entryPrice <= 0.4) depth = b.askDepthAt040;
    else depth = b.askDepthAt050;
    depthAtEntry.push(depth);
    notionalAvailable.push(depth * e.entryPrice);
    if (depth > 0) withDepth++;
  }

  // Book-implied probability: use every observation's mid for the Up side, and the
  // round's realized outcome.
  const roundBySlug = new Map(rounds.map((r) => [r.slug, r]));
  for (const b of books) {
    if (b.side !== 'up' || b.mid === null) continue;
    const r = roundBySlug.get(b.slug);
    if (!r || r.resolvedUp === null) continue;
    bookImplied.push(b.mid);
    realized.push(r.resolvedUp >= 0.5 ? 1 : 0);
  }

  console.log(`\n${'='.repeat(74)}`);
  console.log(`THE QUESTION: was the tape's entry price actually available?`);
  console.log(`${'='.repeat(74)}`);
  console.log(`  entries matched to a book observation : ${matched}/${entries.length}`);
  if (matched === 0) {
    console.log(`\n  No overlap between entries and observations. Run the recorder longer.`);
    return;
  }
  console.log(
    `  tape price >= live best ask (fillable) : ${tapeAtOrAboveBestAsk}/${matched}  ` +
      `(${((tapeAtOrAboveBestAsk / matched) * 100).toFixed(1)}%)`
  );
  console.log(
    `  tape price <  live best ask (NOT fill).: ${tapeBelowBestAsk}/${matched}  ` +
      `(${((tapeBelowBestAsk / matched) * 100).toFixed(1)}%)`
  );
  console.log(`  had depth at or below tape price       : ${withDepth}/${matched}  (${((withDepth / matched) * 100).toFixed(1)}%)`);
  console.log(`
  distribution of (bestAsk - tapePrice), cents:
    p10=${quantile(gapToAskCents, 0.1).toFixed(2)}  p50=${quantile(gapToAskCents, 0.5).toFixed(2)}  p90=${quantile(gapToAskCents, 0.9).toFixed(2)}  mean=${mean(gapToAskCents).toFixed(2)}`);
  console.log(`
  live best ask at entry, cents:
    p10=${quantile(askAtEntry, 0.1).toFixed(3)}  p50=${quantile(askAtEntry, 0.5).toFixed(3)}  p90=${quantile(askAtEntry, 0.9).toFixed(3)}`);
  console.log(`
  depth available at/below tape price (shares):
    p10=${quantile(depthAtEntry, 0.1).toFixed(0)}  p50=${quantile(depthAtEntry, 0.5).toFixed(0)}  p90=${quantile(depthAtEntry, 0.9).toFixed(0)}`);
  console.log(`
  notional available at/below tape price (USD):
    p10=$${quantile(notionalAvailable, 0.1).toFixed(2)}  p50=$${quantile(notionalAvailable, 0.5).toFixed(2)}  p90=$${quantile(notionalAvailable, 0.9).toFixed(2)}`);
  console.log(`
  book observations: age p50=${quantile(bookAges, 0.5).toFixed(0)}ms p90=${quantile(bookAges, 0.9).toFixed(0)}ms   spread p50=${quantile(spreads, 0.5).toFixed(3)}`);
  console.log(
    `  (book.mid - tapePrice) cents: p50=${quantile(bookMidVsTape, 0.5).toFixed(2)}  <- positive means tape price was BELOW mid`
  );

  if (bookImplied.length > 0) {
    console.log(`\n${'='.repeat(74)}`);
    console.log(`BOOK-IMPLIED PROBABILITY vs REALIZED OUTCOME (Up side)`);
    console.log(`${'='.repeat(74)}`);
    // Calibration buckets.
    const buckets: Array<[number, number]> = [
      [0, 0.1],
      [0.1, 0.25],
      [0.25, 0.4],
      [0.4, 0.6],
      [0.6, 0.75],
      [0.75, 0.9],
      [0.9, 1.01],
    ];
    console.log('  mid bucket        n     meanMid   realizedUp   diff(pp)');
    for (const [lo, hi] of buckets) {
      const idx = bookImplied
        .map((m, i) => (m >= lo && m < hi ? i : -1))
        .filter((i) => i >= 0);
      if (idx.length < 10) continue;
      const mm = mean(idx.map((i) => bookImplied[i]));
      const rr = mean(idx.map((i) => realized[i]));
      console.log(
        `  [${lo.toFixed(2)},${hi.toFixed(2)})  ${String(idx.length).padStart(6)}   ${mm.toFixed(3)}     ${rr.toFixed(3)}      ${((rr - mm) * 100).toFixed(1)}`
      );
    }
    console.log(
      `\n  A mid far from the realized rate means the book is miscalibrated; small\n` +
        `  differences mean the book is efficient and the edge must come from timing.`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

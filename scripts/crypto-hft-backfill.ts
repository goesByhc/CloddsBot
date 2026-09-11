/**
 * Backfill tick-level round data for the crypto-hft backtester.
 *
 * WHY NOT prices-history
 * ---------------------
 * `clob.polymarket.com/prices-history` is hard-capped at 24 hours: interval=max,
 * 1w and 1m all silently degrade to 1d, and fidelity=1 beyond that 400s. That
 * caps a backtest at ~96 rounds of 15-minute data.
 *
 * `data-api.polymarket.com/trades` has no such cap. It returns individual fills
 * with timestamp / price / size / side / outcome, which for a 15-minute BTC round
 * is ~600 trades covering ~885 of 900 seconds — roughly one trade every 1.5s,
 * versus 15 points from prices-history. Verified retrievable at least 120 days back.
 *
 * This script walks rounds backwards from now, pulls each round's full trade tape,
 * splits it by outcome token, and caches one JSONL line per round so runs are
 * resumable and the tape is only fetched once.
 *
 *   npx tsx scripts/crypto-hft-backfill.ts --asset btc --duration 15m --days 7
 *   npx tsx scripts/crypto-hft-backfill.ts --asset btc --duration 15m --days 120 --min-trades 20
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';

const GAMMA_URL = 'https://gamma-api.polymarket.com';
const DATA_URL = 'https://data-api.polymarket.com';

export interface Tick {
  /** unix seconds */
  t: number;
  /** price in [0,1] */
  p: number;
  /** shares */
  s: number;
  /** aggressor side */
  side: 'BUY' | 'SELL';
}

export interface RoundTape {
  slug: string;
  asset: string;
  durationLabel: string;
  /** round window, unix seconds */
  startSec: number;
  endSec: number;
  upTokenId: string;
  downTokenId: string;
  /** ticks ascending by t, Up token */
  up: Tick[];
  /** ticks ascending by t, Down token */
  down: Tick[];
  /** 1 = Up won, 0 = Down won, null = not resolved */
  resolvedUp: number | null;
  volumeUsd: number;
  /** total trades seen before window clipping (diagnostic) */
  rawTradeCount: number;
}

const DURATION_SEC: Record<string, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function getJson<T>(url: string, timeoutMs = 40_000): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 404) return null;
      if (!res.ok) {
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        return null;
      }
      return (await res.json()) as T;
    } catch {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return null;
}

interface GammaMarket {
  conditionId?: string;
  clobTokenIds?: string;
  outcomePrices?: string;
  volumeNum?: number;
}
interface GammaEvent {
  slug?: string;
  closed?: boolean;
  volume?: number;
  markets?: GammaMarket[];
}
interface RawTrade {
  asset?: string;
  outcome?: string;
  side?: string;
  size?: number;
  price?: number;
  timestamp?: number;
}

/** Paginate the full trade tape for one market condition. */
async function fetchTrades(conditionId: string, maxPages = 60): Promise<RawTrade[]> {
  const out: RawTrade[] = [];
  const pageSize = 500;
  for (let page = 0; page < maxPages; page++) {
    const batch = await getJson<RawTrade[]>(
      `${DATA_URL}/trades?market=${conditionId}&limit=${pageSize}&offset=${page * pageSize}`
    );
    if (!batch || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

function parseOutcomePrices(raw: string | undefined): number | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as string[];
    const up = Number(arr[0]);
    return Number.isFinite(up) ? up : null;
  } catch {
    return null;
  }
}

async function fetchRoundTape(
  asset: string,
  durationLabel: string,
  roundDurationSec: number,
  startSec: number
): Promise<RoundTape | null> {
  const slug = `${asset.toLowerCase()}-updown-${durationLabel}-${startSec}`;
  const events = await getJson<GammaEvent[]>(`${GAMMA_URL}/events?slug=${encodeURIComponent(slug)}`);
  const ev = events?.[0];
  const market = ev?.markets?.[0];
  if (!ev || !market?.conditionId || !market.clobTokenIds) return null;

  let tokens: string[];
  try {
    tokens = JSON.parse(market.clobTokenIds) as string[];
  } catch {
    return null;
  }
  if (!Array.isArray(tokens) || tokens.length < 2) return null;

  const resolvedUp = parseOutcomePrices(market.outcomePrices);
  const isResolved = ev.closed === true || resolvedUp === 1 || resolvedUp === 0;

  const raw = await fetchTrades(market.conditionId);
  if (raw.length === 0) return null;

  const endSec = startSec + roundDurationSec;
  const up: Tick[] = [];
  const down: Tick[] = [];

  for (const tr of raw) {
    const t = tr.timestamp;
    const p = tr.price;
    const s = tr.size;
    if (typeof t !== 'number' || typeof p !== 'number' || typeof s !== 'number') continue;
    if (t < startSec || t > endSec) continue;
    const side: Tick['side'] = tr.side === 'SELL' ? 'SELL' : 'BUY';
    const tick: Tick = { t, p, s, side };
    if (tr.asset === tokens[0]) up.push(tick);
    else if (tr.asset === tokens[1]) down.push(tick);
  }

  if (up.length === 0 && down.length === 0) return null;
  up.sort((a, b) => a.t - b.t);
  down.sort((a, b) => a.t - b.t);

  return {
    slug,
    asset,
    durationLabel,
    startSec,
    endSec,
    upTokenId: tokens[0],
    downTokenId: tokens[1],
    up,
    down,
    resolvedUp: isResolved ? resolvedUp : null,
    volumeUsd: market.volumeNum ?? ev.volume ?? 0,
    rawTradeCount: raw.length,
  };
}

// ── Cache ────────────────────────────────────────────────────────────────────

function cachePath(asset: string, durationLabel: string): string {
  return join(process.cwd(), '.cache', 'crypto-hft', `${asset}-${durationLabel}.jsonl`);
}

function loadCache(path: string): Map<string, RoundTape> {
  const map = new Map<string, RoundTape>();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const tape = JSON.parse(trimmed) as RoundTape;
      if (tape?.slug) map.set(tape.slug, tape);
    } catch {
      /* skip corrupt line */
    }
  }
  return map;
}

async function main() {
  const asset = arg('asset', 'btc').toLowerCase();
  const duration = arg('duration', '15m');
  const days = Number(arg('days', '7'));
  const minTrades = Number(arg('min-trades', '10'));
  const concurrency = Number(arg('concurrency', '6'));
  const fresh = flag('fresh');

  const roundDurationSec = DURATION_SEC[duration];
  if (!roundDurationSec) {
    console.error(`unsupported --duration ${duration}; use ${Object.keys(DURATION_SEC).join(', ')}`);
    process.exit(1);
  }

  const dir = join(process.cwd(), '.cache', 'crypto-hft');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = cachePath(asset, duration);
  if (fresh && existsSync(path)) {
    renameSync(path, `${path}.replaced-${Date.now()}`);
    console.log(`existing cache moved aside`);
  }

  const cache = loadCache(path);
  const nowSec = Math.floor(Date.now() / 1000);
  const currentSlot = Math.floor(nowSec / roundDurationSec) * roundDurationSec;
  const totalRounds = Math.floor((days * 86400) / roundDurationSec);

  console.log(
    `\nBackfill ${asset.toUpperCase()} ${duration}: ${totalRounds} rounds over ${days}d, ` +
      `min-trades ${minTrades}, concurrency ${concurrency}`
  );
  console.log(`cache: ${path} (${cache.size} rounds already present)`);

  // Build the slot list oldest-first so progress reads naturally.
  const slots: number[] = [];
  for (let i = totalRounds; i >= 1; i--) {
    slots.push(currentSlot - i * roundDurationSec);
  }

  let fetched = 0;
  let skippedCached = 0;
  let skippedThin = 0;
  let failed = 0;
  let kept = 0;
  const startedAt = Date.now();
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor++;
      if (idx >= slots.length) return;
      const startSec = slots[idx];
      const slug = `${asset}-updown-${duration}-${startSec}`;

      if (cache.has(slug)) {
        skippedCached++;
        continue;
      }

      const tape = await fetchRoundTape(asset, duration, roundDurationSec, startSec);
      fetched++;

      if (!tape) {
        failed++;
      } else if (tape.up.length + tape.down.length < minTrades) {
        skippedThin++;
      } else {
        cache.set(slug, tape);
        // Append immediately so an interrupted run keeps its progress.
        appendFileSync(path, JSON.stringify(tape) + '\n');
        kept++;
      }

      if (fetched % 25 === 0 || idx === slots.length - 1) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = fetched / Math.max(elapsed, 0.001);
        const etaMin = (slots.length - idx) / Math.max(rate, 0.001) / 60;
        process.stdout.write(
          `\r  ${idx + 1}/${slots.length}  kept ${kept}  thin ${skippedThin}  empty ${failed}  ` +
            `${rate.toFixed(1)}/s  eta ${etaMin.toFixed(1)}m   `
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const elapsed = (Date.now() - startedAt) / 1000;
  const tapes = Array.from(cache.values());
  const withTrades = tapes.filter((t) => t.up.length + t.down.length >= minTrades);
  const totalTicks = withTrades.reduce((s, t) => s + t.up.length + t.down.length, 0);
  const resolved = withTrades.filter((t) => t.resolvedUp !== null).length;

  console.log(`\n\nDone in ${(elapsed / 60).toFixed(1)} min`);
  console.log(`  rounds in cache      : ${tapes.length}`);
  console.log(`  usable (>=${minTrades} ticks): ${withTrades.length}`);
  console.log(`  skipped (already had): ${skippedCached}`);
  console.log(`  skipped (too thin)   : ${skippedThin}`);
  console.log(`  empty / unresolved   : ${failed}`);
  console.log(`  total ticks          : ${totalTicks.toLocaleString()}`);
  if (withTrades.length) {
    console.log(`  avg ticks/round      : ${Math.round(totalTicks / withTrades.length)}`);
    console.log(`  resolved rounds      : ${resolved}/${withTrades.length}`);
    const sorted = withTrades.map((t) => t.startSec).sort((a, b) => a - b);
    console.log(
      `  window               : ${new Date(sorted[0] * 1000).toISOString().slice(0, 16)} .. ` +
        `${new Date(sorted[sorted.length - 1] * 1000).toISOString().slice(0, 16)}`
    );
  }
  console.log(`\nCache file: ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

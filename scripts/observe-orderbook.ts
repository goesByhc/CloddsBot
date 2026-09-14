/**
 * Order-book observer for the crypto-hft markets.
 *
 * WHAT THIS ANSWERS
 * -----------------
 * The tick backtester fills at the traded print. Every P&L number it produces
 * assumes you could have bought at that price, and the strategy's entries cluster
 * at low prices (median ~0.26, a quarter at or below 0.05) where depth is the
 * least certain. Order-book history is not available, so that assumption cannot be
 * checked retroactively 鈥?it has to be observed forward.
 *
 * This recorder polls the live CLOB book for every active crypto Up/Down token and
 * writes one NDJSON line per token per tick. It touches no order path and needs no
 * credentials.
 *
 *   npx tsx scripts/observe-orderbook.ts --assets btc,eth,sol --duration 15m
 *   npx tsx scripts/observe-orderbook.ts --assets btc --duration 15m --once
 *
 * Analysis: scripts/analyze-orderbook.ts joins this with the round tape to answer
 * "was the price the strategy assumes actually available, and in what size?".
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const GAMMA_URL = 'https://gamma-api.polymarket.com';
const CLOB_URL = 'https://clob.polymarket.com';

const DURATION_SEC: Record<string, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
};

interface Level {
  price: string;
  size: string;
}
interface BookResponse {
  asset_id?: string;
  bids?: Level[];
  asks?: Level[];
  timestamp?: string;
  tick_size?: string;
  min_order_size?: string;
  last_trade_price?: string;
}

/** One recorded observation for a single token. */
interface BookObservation {
  /** observation wall-clock, ms */
  ts: number;
  slug: string;
  asset: string;
  durationLabel: string;
  roundStart: number;
  roundEnd: number;
  roundAgeSec: number;
  timeLeftSec: number;
  side: 'up' | 'down';
  tokenId: string;
  /** book's own timestamp, ms (detects stale books) */
  bookTs: number | null;
  /** |local now - bookTs|; exchange clock is typically ahead, so this is absolute */
  bookAgeMs: number | null;
  /** signed local-now minus bookTs, for diagnosing clock offset */
  clockSkewMs?: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  mid: number | null;
  bidDepth: number;
  askDepth: number;
  /** shares available at or below each reference price (taker buys) */
  askDepthAt005: number;
  askDepthAt010: number;
  askDepthAt026: number;
  askDepthAt040: number;
  askDepthAt050: number;
  /** notional in USD available at or below each reference price */
  askNotionalAt005: number;
  askNotionalAt010: number;
  askNotionalAt026: number;
  askNotionalAt040: number;
  askNotionalAt050: number;
  lastTradePrice: number | null;
  fetchLatencyMs: number;
  error?: string;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function getJson<T>(url: string, timeoutMs = 20_000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface GammaMarket {
  slug?: string;
  clobTokenIds?: string;
}
interface GammaEvent {
  slug?: string;
  markets?: GammaMarket[];
}

/** Resolve the two CLOB token ids for a round by slug. */
async function resolveTokens(
  asset: string,
  durationLabel: string,
  startSec: number
): Promise<{ slug: string; up: string; down: string } | null> {
  const slug = `${asset}-updown-${durationLabel}-${startSec}`;
  const events = await getJson<GammaEvent[]>(`${GAMMA_URL}/events?slug=${encodeURIComponent(slug)}`);
  const market = events?.[0]?.markets?.[0];
  if (!market?.clobTokenIds) return null;
  try {
    const tokens = JSON.parse(market.clobTokenIds) as string[];
    if (!Array.isArray(tokens) || tokens.length < 2) return null;
    return { slug, up: tokens[0], down: tokens[1] };
  } catch {
    return null;
  }
}

/** Shares and notional available at or below `limit` on the ask side. */
function depthBelow(asks: Array<[number, number]>, limit: number): { shares: number; notional: number } {
  let shares = 0;
  let notional = 0;
  for (const [p, s] of asks) {
    if (p <= limit) {
      shares += s;
      notional += p * s;
    }
  }
  return { shares, notional };
}

const REFERENCE_PRICES = [0.05, 0.1, 0.26, 0.4, 0.5];

async function observeToken(
  meta: { slug: string; asset: string; durationLabel: string; roundStart: number; roundEnd: number },
  side: 'up' | 'down',
  tokenId: string,
  now: number
): Promise<BookObservation> {
  const t0 = Date.now();
  const book = await getJson<BookResponse>(`${CLOB_URL}/book?token_id=${encodeURIComponent(tokenId)}`);
  const latency = Date.now() - t0;

  const base: BookObservation = {
    ts: now,
    slug: meta.slug,
    asset: meta.asset,
    durationLabel: meta.durationLabel,
    roundStart: meta.roundStart,
    roundEnd: meta.roundEnd,
    roundAgeSec: now - meta.roundStart,
    timeLeftSec: meta.roundEnd - now,
    side,
    tokenId,
    bookTs: null,
    bookAgeMs: null,
    bestBid: null,
    bestAsk: null,
    spread: null,
    mid: null,
    bidDepth: 0,
    askDepth: 0,
    askDepthAt005: 0,
    askDepthAt010: 0,
    askDepthAt026: 0,
    askDepthAt040: 0,
    askDepthAt050: 0,
    askNotionalAt005: 0,
    askNotionalAt010: 0,
    askNotionalAt026: 0,
    askNotionalAt040: 0,
    askNotionalAt050: 0,
    lastTradePrice: null,
    fetchLatencyMs: latency,
  };

  if (!book) {
    base.error = 'book_fetch_failed';
    return base;
  }

  const bids: Array<[number, number]> = (book.bids ?? [])
    .map((l) => [Number(l.price), Number(l.size)] as [number, number])
    .filter(([p, s]) => Number.isFinite(p) && Number.isFinite(s) && s > 0)
    .sort((a, b) => b[0] - a[0]);
  const asks: Array<[number, number]> = (book.asks ?? [])
    .map((l) => [Number(l.price), Number(l.size)] as [number, number])
    .filter(([p, s]) => Number.isFinite(p) && Number.isFinite(s) && s > 0)
    .sort((a, b) => a[0] - b[0]);

  const bestBid = bids.length ? bids[0][0] : null;
  const bestAsk = asks.length ? asks[0][0] : null;
  base.bestBid = bestBid;
  base.bestAsk = bestAsk;
  base.spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  base.mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  base.bidDepth = bids.reduce((s, [, sz]) => s + sz, 0);
  base.askDepth = asks.reduce((s, [, sz]) => s + sz, 0);

  const d005 = depthBelow(asks, 0.05);
  const d010 = depthBelow(asks, 0.1);
  const d026 = depthBelow(asks, 0.26);
  const d040 = depthBelow(asks, 0.4);
  const d050 = depthBelow(asks, 0.5);
  base.askDepthAt005 = d005.shares;
  base.askDepthAt010 = d010.shares;
  base.askDepthAt026 = d026.shares;
  base.askDepthAt040 = d040.shares;
  base.askDepthAt050 = d050.shares;
  base.askNotionalAt005 = d005.notional;
  base.askNotionalAt010 = d010.notional;
  base.askNotionalAt026 = d026.notional;
  base.askNotionalAt040 = d040.notional;
  base.askNotionalAt050 = d050.notional;

  if (book.timestamp) {
    const bt = Number(book.timestamp);
    if (Number.isFinite(bt)) {
      base.bookTs = bt;
      // Signed offset would be misleading: the exchange's clock is typically a few
      // hundred ms ahead of local, which shows up as a negative "age". Report the
      // absolute skew plus a separate staleness flag instead.
      base.bookAgeMs = Math.abs(Date.now() - bt);
      base.clockSkewMs = Date.now() - bt;
    }
  }
  if (book.last_trade_price) {
    const lt = Number(book.last_trade_price);
    if (Number.isFinite(lt)) base.lastTradePrice = lt;
  }
  return base;
}

async function main() {
  const assets = arg('assets', 'btc,eth,sol').split(',').map((a) => a.trim().toLowerCase());
  const duration = arg('duration', '15m');
  const intervalMs = Number(arg('interval-ms', '5000'));
  const maxRounds = Number(arg('max-rounds', '0'));
  const once = flag('once');
  const outDir = arg('out', join(process.cwd(), '.cache', 'orderbook'));

  const roundDurationSec = DURATION_SEC[duration];
  if (!roundDurationSec) {
    console.error(`unsupported --duration ${duration}; use ${Object.keys(DURATION_SEC).join(', ')}`);
    process.exit(1);
  }
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `book-${assets.join('-')}-${duration}-${Date.now()}.jsonl`);

  console.log(`\nOrder-book observer`);
  console.log(`  assets      : ${assets.join(', ')}`);
  console.log(`  duration    : ${duration} (${roundDurationSec}s rounds)`);
  console.log(`  interval    : ${intervalMs}ms`);
  console.log(`  output      : ${outPath}`);
  if (maxRounds > 0) console.log(`  round limit : ${maxRounds}`);
  console.log(`\n  NOTE: read-only. Polls the public CLOB book; touches no order path.\n`);

  let records = 0;
  let errors = 0;
  let roundsSeen = new Set<string>();
  let lastRoundStart = 0;
  let cached: Array<{ asset: string; side: 'up' | 'down'; tokenId: string; slug: string }> = [];
  let cachedMeta: { slug: string; asset: string; durationLabel: string; roundStart: number; roundEnd: number } | null = null;
  const startedAt = Date.now();

  /** Resolve tokens and cache the raw book for offline replay of exact ladders. */
  const rawPath = outPath.replace('.jsonl', '-raw.jsonl');
  const rawPending: string[] = [];

  async function tick(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const slot = Math.floor(nowSec / roundDurationSec) * roundDurationSec;

    if (slot !== lastRoundStart) {
      // New round: resolve tokens for every asset.
      cached = [];
      let meta: typeof cachedMeta = null;
      const failures: string[] = [];
      for (const a of assets) {
        const r = await resolveTokens(a, duration, slot);
        if (!r) {
          failures.push(a);
          continue;
        }
        if (!meta) {
          meta = {
            slug: r.slug,
            asset: a,
            durationLabel: duration,
            roundStart: slot,
            roundEnd: slot + roundDurationSec,
          };
        }
        // Carry a PER-ASSET slug on each token entry. Previously every record was
        // written with meta.slug, which is the FIRST asset that resolved - so eth and
        // sol rows carried a `btc-...` slug. Any join on slug then silently matched
        // nothing, and it was hard to see because the round start stayed correct.
        cached.push({ asset: a, side: 'up', tokenId: r.up, slug: r.slug });
        cached.push({ asset: a, side: 'down', tokenId: r.down, slug: r.slug });
      }
      cachedMeta = meta;
      lastRoundStart = slot;
      if (failures.length) {
        console.log(`    token resolution failed for: ${failures.join(', ')} (round ${slot})`);
      }
      if (meta) {
        for (const c of cached) roundsSeen.add(c.slug);
        console.log(
          `  [${new Date().toISOString().slice(11, 19)}] new round ${meta.slug} (${cached.length} tokens), rounds=${roundsSeen.size}`
        );
      }
    }

    if (cached.length === 0 || !cachedMeta) return;

    const lines: string[] = [];
    for (const t of cached) {
      const obs = await observeToken(cachedMeta, t.side, t.tokenId, nowSec);
      obs.asset = t.asset;
      // Per-asset slug, so a join on slug resolves to the same round the tape uses.
      obs.slug = t.slug;
      if (obs.error) errors++;
      lines.push(JSON.stringify(obs));
      records++;
    }
    // Flush with retry, like the tape writer.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        appendFileSync(outPath, lines.join('\n') + '\n');
        break;
      } catch {
        const until = Date.now() + 120 * (attempt + 1);
        while (Date.now() < until) {
          /* backoff */
        }
      }
    }
    if (records % (cached.length * 12) === 0) {
      const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
      process.stdout.write(`\r  records ${records}  errors ${errors}  rounds ${roundsSeen.size}  ${mins}m   `);
    }
  }

  await tick();
  if (once) {
    console.log(`\n  --once: wrote ${records} records to ${outPath}`);
    return;
  }

  // Loop with a self-correcting timer so slow fetches do not drift.
  for (;;) {
    const target = Date.now() + intervalMs;
    await tick();
    if (maxRounds > 0 && roundsSeen.size >= maxRounds) {
      console.log(`\n\n  reached --max-rounds ${maxRounds}; stopping`);
      break;
    }
    const wait = target - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\n  stopped after ${mins} min, ${records} records, ${errors} errors`);
  console.log(`  output: ${outPath}`);
  if (rawPending.length) console.log(`  raw:    ${rawPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

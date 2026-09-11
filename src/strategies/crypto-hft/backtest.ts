/**
 * Round-driven backtester for the crypto-hft strategy.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/trading/backtest.ts` is a generic OHLCV engine whose `resolveStrategy()`
 * (gateway/api-routes.ts:403) hardcodes exactly three strategies: mean-reversion,
 * momentum and buy-and-hold. The crypto-hft strategy is not reachable from it, so
 * nothing in the repo could answer "does this strategy survive its own fees?".
 *
 * The live crypto-hft code is also NOT replayable: every `evaluate*` function and
 * the `PriceBuffer` window helpers read `Date.now()` internally
 * (strategies.ts:44,54; positions.ts:225,331,385). This module therefore
 * reimplements the two data-computable predicates as pure functions over an
 * explicit `now`, and drives them per round.
 *
 * DATA HONESTY — READ THIS BEFORE TRUSTING A NUMBER
 * -------------------------------------------------
 * The only free, credential-free historical source is Polymarket's own APIs:
 *   - round enumeration:  GET gamma-api.polymarket.com/events?series_slug=...&closed=true
 *   - intra-round prices: GET clob.polymarket.com/prices-history?market=<tokenId>&fidelity=1&interval=1d
 *
 * That gives ~1 point per MINUTE for the last ~24h. It does NOT give:
 *   - sub-minute spot prices  (momentum needs 5s/30s windows -> NOT testable)
 *   - orderbook snapshots     (penny_clipper returns null without a book -> NOT testable)
 *   - historical spread/OBI   (so spread gates are approximated or skipped)
 *
 * Rather than faking precision, each strategy declares a confidence tier, and
 * anything not computable from the available data is reported as SKIPPED instead
 * of being silently approximated. See `StrategyTier`.
 *
 * FEES
 * ----
 * Uses the live `takerFee()` from ./types (Polymarket: fee = C × feeRate × p × (1−p),
 * feeRate 0.07 for crypto markets). Makers pay nothing.
 */

import { CRYPTO_FEE_RATE, takerFee } from './types';

// =============================================================================
// HISTORICAL DATA
// =============================================================================

const GAMMA_URL = 'https://gamma-api.polymarket.com';
const CLOB_URL = 'https://clob.polymarket.com';

export interface PricePoint {
  /** unix seconds */
  t: number;
  /** price in [0,1] */
  p: number;
}

export interface HistoricalRound {
  slug: string;
  asset: string;
  durationLabel: string;
  /** round window start, unix seconds (= slot boundary) */
  startSec: number;
  endSec: number;
  upTokenId: string;
  downTokenId: string;
  /** intra-round series, ascending by t, 1-minute fidelity */
  upSeries: PricePoint[];
  downSeries: PricePoint[];
  /** resolved outcome: 1 = Up won, 0 = Down won, null = unresolved */
  resolvedUp: number | null;
  /** per-round traded volume in USDC (liquidity proxy) */
  volumeUsd: number;
}

interface GammaEvent {
  slug?: string;
  closed?: boolean;
  volume?: number;
  markets?: Array<{
    slug?: string;
    closed?: boolean;
    clobTokenIds?: string;
    outcomePrices?: string;
    volumeNum?: number;
    liquidityNum?: number;
  }>;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Parse `["1","0"]` or `["0.5","0.5"]` into a number. */
function parseOutcomePrices(raw: string | undefined): number | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as string[];
    if (!Array.isArray(arr) || arr.length < 2) return null;
    const up = Number(arr[0]);
    return Number.isFinite(up) ? up : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the intra-round price series for one token.
 *
 * `fidelity=1&interval=1d` is the only combination that returns minute-level
 * points for these short-duration markets; `interval=max` silently degrades to
 * ~2 points per 15-minute round, which is useless. Verified empirically.
 */
export async function fetchTokenSeries(tokenId: string): Promise<PricePoint[]> {
  const data = await fetchJson<{ history?: PricePoint[] }>(
    `${CLOB_URL}/prices-history?market=${encodeURIComponent(tokenId)}&fidelity=1&interval=1d`
  );
  const hist = data?.history ?? [];
  return hist
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.p))
    .sort((a, b) => a.t - b.t);
}

/**
 * Walk backwards from the current slot, resolving one round per slug.
 *
 * WHY NOT `series_slug`: `/events?series_slug=...&closed=true` returns the OLDEST
 * entries of a long-running series (it starts at the series' first round and the
 * `ascending` parameter is ignored), so it yields rounds from months ago whose
 * price history has already aged out of the CLOB window. Enumerating slugs
 * backwards from `now` is deterministic and always lands on live-history rounds.
 *
 * A round is skipped when it has not resolved yet (outcome prices still track the
 * live market) unless `includeUnresolved` is set.
 */
export async function fetchRecentRounds(opts: {
  asset: string;
  durationLabel: string;
  roundDurationSec: number;
  /** how many resolved rounds to collect */
  limit?: number;
  /** how many slots back to scan at most */
  maxScan?: number;
  nowSec?: number;
  includeUnresolved?: boolean;
}): Promise<HistoricalRound[]> {
  const { asset, durationLabel, roundDurationSec } = opts;
  const limit = opts.limit ?? 24;
  const maxScan = opts.maxScan ?? limit * 3 + 4;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const currentSlot = Math.floor(nowSec / roundDurationSec) * roundDurationSec;

  const rounds: HistoricalRound[] = [];

  for (let i = 1; i <= maxScan && rounds.length < limit; i++) {
    const startSec = currentSlot - i * roundDurationSec;
    const slug = `${asset.toLowerCase()}-updown-${durationLabel}-${startSec}`;

    const events = await fetchJson<GammaEvent[]>(
      `${GAMMA_URL}/events?slug=${encodeURIComponent(slug)}`
    );
    const ev = events?.[0];
    const market = ev?.markets?.[0];
    if (!ev || !market?.clobTokenIds) continue;

    const resolvedUp = parseOutcomePrices(market.outcomePrices);
    // An unresolved round's "outcome prices" are just the live book — not an outcome.
    const isResolved = ev.closed === true || (resolvedUp === 1 || resolvedUp === 0);
    if (!isResolved && !opts.includeUnresolved) continue;

    let tokens: string[];
    try {
      tokens = JSON.parse(market.clobTokenIds) as string[];
    } catch {
      continue;
    }
    if (!Array.isArray(tokens) || tokens.length < 2) continue;

    const endSec = startSec + roundDurationSec;
    const [upSeries, downSeries] = await Promise.all([
      fetchTokenSeries(tokens[0]),
      fetchTokenSeries(tokens[1]),
    ]);
    if (upSeries.length < 2 && downSeries.length < 2) continue;

    const clip = (series: PricePoint[]) =>
      series.filter((p) => p.t >= startSec && p.t <= endSec);

    rounds.push({
      slug,
      asset,
      durationLabel,
      startSec,
      endSec,
      upTokenId: tokens[0],
      downTokenId: tokens[1],
      upSeries: clip(upSeries),
      downSeries: clip(downSeries),
      resolvedUp: isResolved ? resolvedUp : null,
      volumeUsd: market.volumeNum ?? ev.volume ?? 0,
    });
  }

  return rounds.sort((a, b) => a.startSec - b.startSec);
}

// =============================================================================
// PURE PRICE BUFFER (clock injected, unlike the live one)
// =============================================================================

export interface PurePriceBuffer {
  push(price: number, ts: number): void;
  reversals(windowSec: number, minStep: number, now: number): number;
  range(windowSec: number, now: number): number;
  mean(windowSec: number, now: number): number;
  movePct(windowSec: number, now: number): number;
  count(): number;
}

/**
 * Same semantics as `createPriceBuffer`, but every window takes an explicit `now`.
 *
 * Two performance problems had to be solved to make a 672-round tick replay
 * feasible; the live implementation is fine live but quadratic over ~650k prints:
 *
 *  1. `unshift()` memmoves the whole array per tick. Points are therefore stored
 *     ASCENDING and appended with `push()`.
 *  2. Windows were rebuilt with `Array.filter` and `Math.max(...map)` on every
 *     call, scanning ~2000 entries several times per tick. Window bounds are now
 *     found by binary search over the ascending timestamps, so only the window's
 *     own points are scanned.
 *
 * RETENTION SEMANTICS ARE PRESERVED. The live `prune()` applies two rules in
 * order: drop older than maxAgeSec, then truncate to 2000 entries. The second
 * rule is a FLOOR, not a ceiling, because at ~1.5s print spacing 180s holds only
 * ~120 points, so a 30/60/120s window is always fully inside what is retained.
 * Keeping `maxAgeSec` of history here is therefore behaviourally identical for
 * every window the strategies use, verified against a reference implementation
 * over 40k values by scripts/verify-buffer-equiv.ts.
 */
export function createPurePriceBuffer(maxAgeSec = 180): PurePriceBuffer {
  // ascending in time (oldest first); [start, length) is the live range
  const prices: PricePoint[] = [];
  let start = 0;

  function advance(now: number) {
    const cutoff = now - maxAgeSec * 1000;
    while (start < prices.length && prices[start].t < cutoff) start++;
    if (start > 8192 && start * 2 > prices.length) {
      prices.splice(0, start);
      start = 0;
    }
  }

  /** Index of the first live entry with t >= cutoff, or prices.length. */
  function lowerBound(cutoff: number): number {
    let lo = start;
    let hi = prices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (prices[mid].t < cutoff) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  return {
    push(price, ts) {
      prices.push({ t: ts, p: price });
      advance(ts);
    },
    reversals(windowSec, minStep, now) {
      advance(now);
      const lo = lowerBound(now - windowSec * 1000);
      const n = prices.length - lo;
      if (n < 3) return 0;
      // Walk newest -> oldest, comparing consecutive pairs so the direction
      // sequence matches the live implementation.
      let count = 0;
      let lastDir: 'up' | 'down' | null = null;
      let newerP = prices[prices.length - 1].p;
      for (let i = prices.length - 2; i >= lo; i--) {
        const diff = newerP - prices[i].p; // newer minus older
        if (Math.abs(diff) >= minStep) {
          const dir: 'up' | 'down' = diff > 0 ? 'up' : 'down';
          if (lastDir && dir !== lastDir) count++;
          lastDir = dir;
        }
        newerP = prices[i].p;
      }
      return count;
    },
    range(windowSec, now) {
      advance(now);
      const lo = lowerBound(now - windowSec * 1000);
      if (lo >= prices.length) return 0;
      let min = Infinity;
      let max = -Infinity;
      for (let i = lo; i < prices.length; i++) {
        const v = prices[i].p;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      return max - min;
    },
    mean(windowSec, now) {
      advance(now);
      const lo = lowerBound(now - windowSec * 1000);
      if (lo >= prices.length) return 0;
      let sum = 0;
      for (let i = lo; i < prices.length; i++) sum += prices[i].p;
      return sum / (prices.length - lo);
    },
    movePct(windowSec, now) {
      advance(now);
      const lo = lowerBound(now - windowSec * 1000);
      if (prices.length - lo < 2) return 0;
      const newest = prices[prices.length - 1].p;
      const oldest = prices[lo].p;
      if (oldest === 0) return 0;
      return ((newest - oldest) / oldest) * 100;
    },
    count() {
      return prices.length - start;
    },
  };
}

// =============================================================================
// STRATEGY PORTS (pure, no Date.now)
// =============================================================================

export type Direction = 'up' | 'down';

export type StrategyName = 'mean_reversion' | 'expiry_fade' | 'momentum';

export interface Signal {
  strategy: StrategyName;
  direction: Direction;
  entryPrice: number;
  confidence: number;
  orderMode: 'maker' | 'taker';
  reason: string;
}

export interface MeanReversionCfg {
  cheapThreshold: number;
  expensiveThreshold: number;
  minRoundAgeSec: number;
  maxSpotMovePct: number;
}

export const DEFAULT_MR: MeanReversionCfg = {
  cheapThreshold: 0.30,
  expensiveThreshold: 0.72,
  minRoundAgeSec: 120,
  maxSpotMovePct: 0.08,
};

/**
 * Port of `evaluateMeanReversion` (strategies.ts:205).
 *
 * DEVIATION, stated explicitly: the live version takes `book` and rejects when
 * `book.obi < -0.1`. No historical orderbook exists, so OBI is unavailable. We
 * therefore cannot apply that gate. Rather than inventing an OBI, callers pass
 * `tier: 'approximate'` for this strategy so the omission is visible in output.
 */
export function evaluateMeanReversionPure(
  input: {
    upPrice: number;
    downPrice: number;
    roundAgeSec: number;
    spotMovePct: number;
  },
  cfg: MeanReversionCfg = DEFAULT_MR
): Signal | null {
  const { upPrice, downPrice, roundAgeSec, spotMovePct } = input;
  if (roundAgeSec < cfg.minRoundAgeSec) return null;
  if (Math.abs(spotMovePct) > cfg.maxSpotMovePct) return null;

  let direction: Direction;
  let price: number;
  if (upPrice <= cfg.cheapThreshold) {
    direction = 'up';
    price = upPrice;
  } else if (downPrice <= cfg.cheapThreshold) {
    direction = 'down';
    price = downPrice;
  } else if (upPrice >= cfg.expensiveThreshold) {
    direction = 'down';
    price = downPrice;
  } else if (downPrice >= cfg.expensiveThreshold) {
    direction = 'up';
    price = upPrice;
  } else {
    return null;
  }

  return {
    strategy: 'mean_reversion',
    direction,
    entryPrice: price,
    confidence: Math.min(1, (1 - price) * 1.5),
    orderMode: 'maker',
    reason: `${direction.toUpperCase()} at ${price.toFixed(2)}, roundAge ${roundAgeSec}s, spot ${spotMovePct.toFixed(3)}%`,
  };
}

export interface ExpiryFadeCfg {
  windowSec: number;
  minSecLeft: number;
  minSkewFromMid: number;
  maxRecentSpotMovePct: number;
}

export const DEFAULT_EXPIRY_FADE: ExpiryFadeCfg = {
  windowSec: 300,
  minSecLeft: 60,
  minSkewFromMid: 0.15,
  maxRecentSpotMovePct: 0.06,
};

export interface MomentumCfg {
  minSpotMovePct: number;
  maxPolyStaleSec: number;
  minLagCents: number;
  spotWindowSec: number;
}

export const DEFAULT_MOMENTUM: MomentumCfg = {
  minSpotMovePct: 0.15,
  maxPolyStaleSec: 5,
  minLagCents: 0.02,
  spotWindowSec: 30,
};

/**
 * Port of `evaluateMomentum` (strategies.ts:131).
 *
 * The spread gate (`book.spreadPct > maxSpreadPct`) is omitted because tick data
 * carries traded prices, not quotes — a spread cannot be derived from prints.
 * Callers must surface that as a tier note.
 */
export function evaluateMomentumPure(
  input: {
    upPrice: number;
    downPrice: number;
    /** spot move over `spotWindowSec`, in percent, signed */
    spotMovePct: number;
    /** seconds since the last observed print on the traded side */
    polyAgeSec: number;
    spotWindowSec: number;
  },
  cfg: MomentumCfg = DEFAULT_MOMENTUM
): Signal | null {
  const { upPrice, downPrice, spotMovePct, polyAgeSec, spotWindowSec } = input;
  if (Math.abs(spotMovePct) < cfg.minSpotMovePct) return null;
  if (polyAgeSec > cfg.maxPolyStaleSec) return null;

  const direction: Direction = spotMovePct > 0 ? 'up' : 'down';
  const price = direction === 'up' ? upPrice : downPrice;

  // The live fairness heuristic: a 0.15% spot move maps to ~5c of binary price.
  const expectedPolyPrice = 0.5 + (Math.abs(spotMovePct) / 100) * 5;
  const lagCents = expectedPolyPrice - price;
  if (lagCents < cfg.minLagCents) return null;

  return {
    strategy: 'momentum',
    direction,
    entryPrice: price,
    confidence: Math.min(1, Math.abs(spotMovePct) / 0.3),
    // 'maker_then_taker' in the live config; charged as taker here because with
    // no quote data a maker fill cannot be assumed (see tier notes).
    orderMode: 'taker',
    reason: `spot ${spotMovePct > 0 ? '+' : ''}${spotMovePct.toFixed(3)}% / ${spotWindowSec}s, lag ${(lagCents * 100).toFixed(1)}c`,
  };
}

/** Port of `evaluateExpiryFade` (strategies.ts:402). `now` is explicit. */
export function evaluateExpiryFadePure(
  input: {
    upPrice: number;
    downPrice: number;
    expiresAtMs: number;
    nowMs: number;
    spotMovePct: number;
  },
  cfg: ExpiryFadeCfg = DEFAULT_EXPIRY_FADE
): Signal | null {
  const { upPrice, downPrice, expiresAtMs, nowMs, spotMovePct } = input;
  const secsToExpiry = (expiresAtMs - nowMs) / 1000;
  if (secsToExpiry > cfg.windowSec || secsToExpiry < cfg.minSecLeft) return null;
  if (Math.abs(spotMovePct) > cfg.maxRecentSpotMovePct) return null;

  const maxSkew = Math.max(Math.abs(upPrice - 0.5), Math.abs(downPrice - 0.5));
  if (maxSkew < cfg.minSkewFromMid) return null;

  const direction: Direction = upPrice < downPrice ? 'up' : 'down';
  const price = direction === 'up' ? upPrice : downPrice;

  return {
    strategy: 'expiry_fade',
    direction,
    entryPrice: price,
    confidence: Math.min(1, maxSkew * 3),
    orderMode: 'taker',
    reason: `${(secsToExpiry / 60).toFixed(1)}min left, ${direction.toUpperCase()} at ${price.toFixed(2)}, skew ${(maxSkew * 100).toFixed(0)}c`,
  };
}

// =============================================================================
// ROUND REPLAY
// =============================================================================

export type StrategyTier =
  /** every input the predicate needs was available */
  | 'faithful'
  /** computable, but one or more gates had to be omitted — see notes */
  | 'approximate'
  /** required inputs are structurally absent from the data source */
  | 'not_testable';

export interface BacktestConfig {
  /** USD notional per entry (live default: 20) */
  sizeUsd: number;
  /** live clamp: minShares 5.15, maxShares 10 (index.ts:212) */
  minShares: number;
  maxShares: number;
  takeProfitPct: number;
  stopLossPct: number;
  /** no new entries with fewer than this many seconds left (live: 130) */
  minTimeLeftSec: number;
  /** force exit with this many seconds left (live: 30) */
  forceExitSec: number;
  /** one position per asset at a time (live: positions.ts:396) */
  onePositionPerAsset: boolean;
  /** extra cents paid on taker entry / given up on taker exit (live: takerBufferCents 0.01) */
  takerBufferCents: number;
  /** apply the Polymarket taker fee model */
  applyFees: boolean;
  feeRate: number;
}

export const DEFAULT_BT_CONFIG: BacktestConfig = {
  sizeUsd: 20,
  minShares: 5.15,
  maxShares: 10,
  takeProfitPct: 15,
  stopLossPct: 12,
  minTimeLeftSec: 130,
  forceExitSec: 30,
  onePositionPerAsset: true,
  takerBufferCents: 0.01,
  applyFees: true,
  feeRate: CRYPTO_FEE_RATE,
};

export interface SimTrade {
  roundSlug: string;
  strategy: StrategyName;
  direction: Direction;
  entryT: number;
  entryPrice: number;
  exitT: number;
  exitPrice: number;
  shares: number;
  /** why the position closed */
  exitReason: 'take_profit' | 'stop_loss' | 'force_exit' | 'round_end' | 'resolution';
  grossPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  orderMode: Signal['orderMode'];
  /** round age at entry, seconds */
  roundAgeSec: number;
  /** seconds from round start to entry (edge-decay probe) */
  secsFromRoundStart: number;
}

export interface BacktestResult {
  strategy: StrategyName;
  tier: StrategyTier;
  notes: string[];
  roundsConsidered: number;
  roundsWithData: number;
  trades: SimTrade[];
  metrics: {
    trades: number;
    wins: number;
    winRate: number;
    grossPnlUsd: number;
    feesUsd: number;
    netPnlUsd: number;
    /** net P&L as % of total notional deployed */
    returnOnNotionalPct: number;
    notionalUsd: number;
    avgTradePct: number;
    bestTradeUsd: number;
    worstTradeUsd: number;
    /** net P&L if fees were ignored — shows how much fees decide the outcome */
    netPnlIfNoFeesUsd: number;
  };
}

/** Entry evaluation happens on each available data point inside the round. */
function replayRound(
  round: HistoricalRound,
  strategy: StrategyName,
  cfg: BacktestConfig
): SimTrade | null {
  const upBuf = createPurePriceBuffer();
  const downBuf = createPurePriceBuffer();

  // Interleave both token series onto a single time axis so we evaluate the round
  // the way the live engine does: one clock, both sides priced simultaneously.
  const times = Array.from(
    new Set([...round.upSeries.map((p) => p.t), ...round.downSeries.map((p) => p.t)])
  ).sort((a, b) => a - b);
  if (times.length < 2) return null;

  const upAt = new Map(round.upSeries.map((p) => [p.t, p.p]));
  const downAt = new Map(round.downSeries.map((p) => [p.t, p.p]));

  let lastUp = round.upSeries[0]?.p ?? 0.5;
  let lastDown = round.downSeries[0]?.p ?? 0.5;

  let open: {
    strategy: StrategyName;
    entryT: number;
    entryPrice: number;
    shares: number;
    direction: Direction;
    orderMode: Signal['orderMode'];
    roundAgeSec: number;
  } | null = null;

  for (const t of times) {
    const nowMs = t * 1000;
    const up = upAt.get(t) ?? lastUp;
    const down = downAt.get(t) ?? lastDown;
    lastUp = up;
    lastDown = down;

    upBuf.push(up, nowMs);
    downBuf.push(down, nowMs);

    const roundAgeSec = t - round.startSec;
    const timeLeftSec = round.endSec - t;

    // ---- exits first (live engine also runs exits before entries) ----
    if (open) {
      const cur = open.direction === 'up' ? up : down;
      const grossPct = ((cur - open.entryPrice) / open.entryPrice) * 100;

      let exitReason: SimTrade['exitReason'] | null = null;
      if (grossPct >= cfg.takeProfitPct) exitReason = 'take_profit';
      else if (grossPct <= -cfg.stopLossPct) exitReason = 'stop_loss';
      else if (timeLeftSec <= cfg.forceExitSec) exitReason = 'force_exit';

      if (exitReason) {
        return closeTrade(round, open, {
          exitT: t,
          exitPrice: cur,
          exitReason,
          cfg,
        });
      }
    }

    // ---- entries ----
    if (open) continue;
    if (roundAgeSec < 30) continue; // live minRoundAgeSec floor
    if (timeLeftSec < cfg.minTimeLeftSec) continue;

    // The only spot proxy available at minute fidelity: mid-price drift over the
    // preceding point. This is NOT the Chainlink TWAP the live code intends to
    // use, so it is documented as an approximation in `tier`/`notes`.
    const midSeries = (upBuf.count() >= 2 ? upBuf : downBuf);
    const spotMovePct = midSeries.movePct(60, nowMs);

    let signal: Signal | null = null;
    if (strategy === 'mean_reversion') {
      signal = evaluateMeanReversionPure({ upPrice: up, downPrice: down, roundAgeSec, spotMovePct });
    } else {
      signal = evaluateExpiryFadePure({
        upPrice: up,
        downPrice: down,
        expiresAtMs: round.endSec * 1000,
        nowMs,
        spotMovePct,
      });
    }
    if (!signal) continue;

    // Sizing: mirror the live fixed-notional clamp.
    const rawShares = Math.floor((cfg.sizeUsd / signal.entryPrice) * 100) / 100;
    const shares = Math.min(Math.max(rawShares, cfg.minShares), cfg.maxShares);

    // Taker entries cross the spread by a flat buffer (live index.ts:267-268).
    const entryPrice =
      signal.orderMode === 'taker'
        ? Math.min(0.99, signal.entryPrice + cfg.takerBufferCents / 100)
        : signal.entryPrice;

    open = {
      strategy,
      entryT: t,
      entryPrice,
      shares,
      direction: signal.direction,
      orderMode: signal.orderMode,
      roundAgeSec,
    };
  }

  // Round ended with a position still open -> settle at the resolved outcome.
  if (open) {
    const upWon = round.resolvedUp !== null && round.resolvedUp >= 0.5;
    // If the market did not resolve, fall back to the last observed price.
    const settlePrice =
      round.resolvedUp === null
        ? (open.direction === 'up' ? lastUp : lastDown)
        : (open.direction === 'up' ? (upWon ? 1 : 0) : upWon ? 0 : 1);
    return closeTrade(round, open, {
      exitT: round.endSec,
      exitPrice: settlePrice,
      exitReason: round.resolvedUp === null ? 'round_end' : 'resolution',
      cfg,
    });
  }

  return null;
}

function closeTrade(
  round: { slug: string; startSec: number },
  open: { strategy: StrategyName; entryT: number; entryPrice: number; shares: number; direction: Direction; orderMode: Signal['orderMode']; roundAgeSec: number },
  args: { exitT: number; exitPrice: number; exitReason: SimTrade['exitReason']; cfg: BacktestConfig }
): SimTrade {
  const { cfg } = args;
  const grossExit = args.exitPrice;

  // Taker exits give up a flat buffer (live index.ts:352-354).
  const exitPrice = open.orderMode === 'taker' ? Math.max(0.01, grossExit - cfg.takerBufferCents / 100) : grossExit;

  const grossPnlUsd = (exitPrice - open.entryPrice) * open.shares;

  let feesUsd = 0;
  if (cfg.applyFees) {
    const entryFeePerShare = open.orderMode === 'maker' ? 0 : takerFee(open.entryPrice, cfg.feeRate);
    const exitFeePerShare = open.orderMode === 'maker' ? 0 : takerFee(exitPrice, cfg.feeRate);
    feesUsd = (entryFeePerShare + exitFeePerShare) * open.shares;
  }

  return {
    roundSlug: round.slug,
    strategy: open.strategy,
    direction: open.direction,
    entryT: open.entryT,
    entryPrice: open.entryPrice,
    exitT: args.exitT,
    exitPrice,
    shares: open.shares,
    exitReason: args.exitReason,
    grossPnlUsd,
    feesUsd,
    netPnlUsd: grossPnlUsd - feesUsd,
    orderMode: open.orderMode,
    roundAgeSec: open.roundAgeSec,
    secsFromRoundStart: open.entryT - round.startSec,
  };
}

export function backtestStrategy(
  rounds: HistoricalRound[],
  strategy: StrategyName,
  cfg: BacktestConfig = DEFAULT_BT_CONFIG
): BacktestResult {
  const notes: string[] = [];
  let tier: StrategyTier = 'approximate';

  if (strategy === 'mean_reversion') {
    notes.push(
      'OBI gate (book.obi >= -0.1, strategies.ts:241) NOT applied — no historical orderbook data available.'
    );
    notes.push(
      'spotMovePct approximated by 60s mid-price drift; the live code intends a Chainlink spot feed, which is not historically free.'
    );
  } else {
    notes.push(
      'spreadPct gate (<= 2.5, strategies.ts:411) NOT applied — historical spread unavailable.'
    );
    notes.push(
      'spotMovePct approximated by 60s mid-price drift (same caveat as mean_reversion).'
    );
    notes.push('taker orderMode, so both entry and exit pay the Polymarket taker fee.');
  }

  const withData = rounds.filter((r) => r.upSeries.length >= 2 && r.downSeries.length >= 2);
  if (withData.length < rounds.length) {
    notes.push(
      `${rounds.length - withData.length}/${rounds.length} rounds had fewer than 2 intra-round points and were skipped.`
    );
  }

  const trades: SimTrade[] = [];
  for (const round of withData) {
    const t = replayRound(round, strategy, cfg);
    if (t) trades.push({ ...t, strategy });
  }

  const notionalUsd = trades.reduce((s, t) => s + t.entryPrice * t.shares, 0);
  const grossPnlUsd = trades.reduce((s, t) => s + t.grossPnlUsd, 0);
  const feesUsd = trades.reduce((s, t) => s + t.feesUsd, 0);
  const netPnlUsd = trades.reduce((s, t) => s + t.netPnlUsd, 0);
  const wins = trades.filter((t) => t.netPnlUsd > 0).length;

  return {
    strategy,
    tier: trades.length === 0 ? 'not_testable' : tier,
    notes,
    roundsConsidered: rounds.length,
    roundsWithData: withData.length,
    trades,
    metrics: {
      trades: trades.length,
      wins,
      winRate: trades.length ? wins / trades.length : 0,
      grossPnlUsd,
      feesUsd,
      netPnlUsd,
      returnOnNotionalPct: notionalUsd > 0 ? (netPnlUsd / notionalUsd) * 100 : 0,
      notionalUsd,
      avgTradePct:
        trades.length && notionalUsd > 0 ? (netPnlUsd / notionalUsd) * 100 : 0,
      bestTradeUsd: trades.length ? Math.max(...trades.map((t) => t.netPnlUsd)) : 0,
      worstTradeUsd: trades.length ? Math.min(...trades.map((t) => t.netPnlUsd)) : 0,
      netPnlIfNoFeesUsd: grossPnlUsd,
    },
  };
}

// =============================================================================
// REPORTING
// =============================================================================

export function formatBacktestReport(results: BacktestResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const m = r.metrics;
    lines.push(`\n=== ${r.strategy} (${r.tier}) ===`);
    lines.push(
      `rounds: ${r.roundsWithData}/${r.roundsConsidered} usable   trades: ${m.trades}   winRate: ${(m.winRate * 100).toFixed(1)}%`
    );
    lines.push(
      `notional $${m.notionalUsd.toFixed(2)}   gross $${m.grossPnlUsd.toFixed(2)}   fees $${m.feesUsd.toFixed(2)}   NET $${m.netPnlUsd.toFixed(2)} (${m.returnOnNotionalPct.toFixed(2)}%)`
    );
    lines.push(
      `best $${m.bestTradeUsd.toFixed(2)}   worst $${m.worstTradeUsd.toFixed(2)}   netIfNoFees $${m.netPnlIfNoFeesUsd.toFixed(2)}`
    );
    if (m.feesUsd > 0) {
      const feeShare = m.grossPnlUsd !== 0 ? (m.feesUsd / Math.abs(m.grossPnlUsd)) * 100 : 0;
      lines.push(`fees consumed ${feeShare.toFixed(1)}% of gross P&L`);
    }
    if (r.trades.length) {
      const avgDelay =
        r.trades.reduce((s, t) => s + t.secsFromRoundStart, 0) / r.trades.length;
      lines.push(`avg entry delay from round start: ${avgDelay.toFixed(0)}s`);
      const byReason = new Map<string, number>();
      for (const t of r.trades) byReason.set(t.exitReason, (byReason.get(t.exitReason) ?? 0) + 1);
      lines.push(
        `exits: ${Array.from(byReason.entries()).map(([k, v]) => `${k}=${v}`).join(', ')}`
      );
    }
    for (const n of r.notes) lines.push(`  note: ${n}`);
  }
  return lines.join('\n');
}

// =============================================================================
// TICK-LEVEL REPLAY (higher fidelity than the minute-bar path above)
// =============================================================================

export interface TickPoint {
  /** unix seconds */
  t: number;
  /** price in [0,1] */
  p: number;
  /** shares */
  s: number;
  side: 'BUY' | 'SELL';
}

/** One round's trade tape, as produced by scripts/crypto-hft-backfill.ts. */
export interface TickRound {
  slug: string;
  asset: string;
  startSec: number;
  endSec: number;
  up: TickPoint[];
  down: TickPoint[];
  resolvedUp: number | null;
  volumeUsd: number;
}

export interface SpotPoint {
  /** unix seconds */
  t: number;
  /** price in quote currency */
  p: number;
}

/**
 * Cached wrapper around `fetchSpotSeries`.
 *
 * A 7-day window at 1s granularity is ~600k points and Binance serves 1000 per
 * request, so a cold fetch is ~600 sequential HTTP calls (the first attempt at
 * this timed out past 10 minutes). Caching makes that a one-time cost.
 */
export async function loadSpotSeries(
  symbol: string,
  startSec: number,
  endSec: number,
  cacheDir: string,
  onProgress?: (points: number) => void
): Promise<SpotPoint[]> {
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('fs');
  const { join } = await import('path');
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, `spot-${symbol}-${startSec}-${endSec}.json`);

  if (existsSync(path)) {
    try {
      const cached = JSON.parse(readFileSync(path, 'utf8')) as SpotPoint[];
      if (Array.isArray(cached) && cached.length > 0) {
        onProgress?.(cached.length);
        return cached;
      }
    } catch {
      /* fall through and refetch */
    }
  }

  const series = await fetchSpotSeries(symbol, startSec, endSec, onProgress);
  if (series.length > 0) {
    try {
      writeFileSync(path, JSON.stringify(series));
    } catch {
      /* cache write is best-effort */
    }
  }
  return series;
}

/**
 * Fetch 1-second spot klines from Binance's public API (no key required).
 *
 * This exists because `momentum` is gated on a 30s spot move, and the settlement
 * reference (Chainlink TWAP) is not historically free. Binance spot is a proxy:
 * it correlates near-perfectly over 30s windows but is NOT the same series, so
 * momentum results carry that caveat.
 */
export async function fetchSpotSeries(
  symbol: string,
  startSec: number,
  endSec: number,
  onProgress?: (points: number, total: number) => void
): Promise<SpotPoint[]> {
  const out: SpotPoint[] = [];
  const limit = 1000;
  let cursor = startSec * 1000;
  const endMs = endSec * 1000;
  let calls = 0;
  // Binance caps limit at 1000, so walk forward.
  while (cursor < endMs) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1s` +
      `&startTime=${cursor}&limit=${limit}`;
    let batch: unknown[] | null = null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 429) {
        // Rate limited —back off and retry the same window.
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!res.ok) break;
      batch = (await res.json()) as unknown[];
    } catch {
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const row of batch) {
      const k = row as [number, string, string, string, string];
      const t = Math.floor(Number(k[0]) / 1000);
      const close = Number(k[4]);
      if (Number.isFinite(t) && Number.isFinite(close)) out.push({ t, p: close });
    }
    const last = out[out.length - 1];
    if (!last) break;
    cursor = (last.t + 1) * 1000;
    calls++;
    if (calls % 25 === 0) onProgress?.(out.length, Math.ceil((endMs - startSec * 1000) / 1000));
    if (batch.length < limit) break;
    // Guard against a pathological loop if the API keeps returning the same page.
    if (calls > 5000) break;
  }
  return out;
}

export interface TickBacktestOptions extends BacktestConfig {
  /** strategy to replay */
  strategy: StrategyName;
  /** 1-second spot series; required for momentum, ignored otherwise */
  spot?: SpotPoint[];
  /**
   * Treat the traded print as the fill price. True reflects that prints are real
   * executions; the residual optimism is that size/queue impact is not modelled.
   */
  trustPrintAsFill?: boolean;
}

/**
 * Replay one round against its trade tape.
 *
 * Evaluation clock is the union of both sides' trade timestamps, so a signal is
 * only considered at an instant when at least one side actually printed. Prices
 * carry forward from the last print — which is exactly why `polyAgeSec` is
 * meaningful here, and why slots left open longer than `maxPolyStaleSec` are
 * skipped the way the live engine would skip them.
 */
function replayTickRound(
  round: TickRound,
  opts: TickBacktestOptions,
  spotIndex: { times: number[]; prices: number[] }
): SimTrade | null {
  const { strategy } = opts;
  const upBuf = createPurePriceBuffer();
  const downBuf = createPurePriceBuffer();
  const spotBuf = createPurePriceBuffer(600);

  const times = Array.from(
    new Set([...round.up.map((x) => x.t), ...round.down.map((x) => x.t)])
  ).sort((a, b) => a - b);
  if (times.length < 3) return null;

  const upAt = new Map(round.up.map((x) => [x.t, x]));
  const downAt = new Map(round.down.map((x) => [x.t, x]));

  // Spot is one global sorted series. Feed it with a cursor instead of building a
  // Map per round: rebuilding a 605k-entry Map for each of 672 rounds was the
  // dominant cost of the first tick run (it did not finish in 20 minutes).
  const spotLen = spotIndex.times.length;
  let scan = 0;
  while (scan < spotLen && spotIndex.times[scan] < round.startSec) scan++;

  let lastUp = round.up[0]?.p ?? 0.5;
  let lastDown = round.down[0]?.p ?? 0.5;
  let lastSpot: number | null = null;
  let lastUpT = round.up[0]?.t ?? round.startSec;
  let lastDownT = round.down[0]?.t ?? round.startSec;

  let open: {
    strategy: StrategyName;
    entryT: number;
    entryPrice: number;
    shares: number;
    direction: Direction;
    orderMode: Signal['orderMode'];
    roundAgeSec: number;
  } | null = null;

  for (const t of times) {
    const nowMs = t * 1000;
    const nowSec = t;
    const upTick = upAt.get(t);
    const downTick = downAt.get(t);
    const up = upTick ? upTick.p : lastUp;
    const down = downTick ? downTick.p : lastDown;
    if (upTick) lastUpT = t;
    if (downTick) lastDownT = t;
    lastUp = up;
    lastDown = down;

    // Advance the spot cursor up to this instant, in order.
    while (scan < spotLen && spotIndex.times[scan] <= nowSec) {
      lastSpot = spotIndex.prices[scan];
      spotBuf.push(lastSpot, spotIndex.times[scan] * 1000);
      scan++;
    }

    upBuf.push(up, nowMs);
    downBuf.push(down, nowMs);

    const roundAgeSec = nowSec - round.startSec;
    const timeLeftSec = round.endSec - nowSec;

    // ── exits first, matching the live engine's ordering ──
    if (open) {
      const cur = open.direction === 'up' ? up : down;
      const grossPct = ((cur - open.entryPrice) / open.entryPrice) * 100;
      let exitReason: SimTrade['exitReason'] | null = null;
      if (grossPct >= opts.takeProfitPct) exitReason = 'take_profit';
      else if (grossPct <= -opts.stopLossPct) exitReason = 'stop_loss';
      else if (timeLeftSec <= opts.forceExitSec) exitReason = 'force_exit';
      if (exitReason) {
        return closeTrade(round, open, {
          exitT: nowSec,
          exitPrice: cur,
          exitReason,
          cfg: opts,
        });
      }
    }

    // ── entries ──
    if (open) continue;
    if (roundAgeSec < 30) continue;
    if (timeLeftSec < opts.minTimeLeftSec) continue;

    // Which side printed most recently drives the staleness gate.
    const polyAgeSec = Math.max(0, nowSec - Math.max(lastUpT, lastDownT));

    if (strategy === 'momentum') {
      if (lastSpot === null) continue;
      const spotMovePct = spotBuf.movePct(30, nowMs);
      const sig = evaluateMomentumPure({
        upPrice: up,
        downPrice: down,
        spotMovePct,
        polyAgeSec,
        spotWindowSec: 30,
      });
      if (!sig) continue;
      open = openFrom(sig, nowSec, roundAgeSec, opts);
    } else if (strategy === 'mean_reversion') {
      const spotMovePct = spotBuf.count() >= 2 ? spotBuf.movePct(60, nowMs) : 0;
      const sig = evaluateMeanReversionPure({
        upPrice: up,
        downPrice: down,
        roundAgeSec,
        spotMovePct,
      });
      if (!sig) continue;
      open = openFrom(sig, nowSec, roundAgeSec, opts);
    } else {
      const spotMovePct = spotBuf.count() >= 2 ? spotBuf.movePct(60, nowMs) : 0;
      const sig = evaluateExpiryFadePure({
        upPrice: up,
        downPrice: down,
        expiresAtMs: round.endSec * 1000,
        nowMs,
        spotMovePct,
      });
      if (!sig) continue;
      open = openFrom(sig, nowSec, roundAgeSec, opts);
    }
  }

  if (open) {
    const upWon = round.resolvedUp !== null && round.resolvedUp >= 0.5;
    const settlePrice =
      round.resolvedUp === null
        ? open.direction === 'up'
          ? lastUp
          : lastDown
        : open.direction === 'up'
          ? upWon
            ? 1
            : 0
          : upWon
            ? 0
            : 1;
    return closeTrade(round, open, {
      exitT: round.endSec,
      exitPrice: settlePrice,
      exitReason: round.resolvedUp === null ? 'round_end' : 'resolution',
      cfg: opts,
    });
  }
  return null;
}

function openFrom(
  sig: Signal,
  nowSec: number,
  roundAgeSec: number,
  opts: BacktestConfig
): {
  strategy: StrategyName;
  entryT: number;
  entryPrice: number;
  shares: number;
  direction: Direction;
  orderMode: Signal['orderMode'];
  roundAgeSec: number;
} {
  const rawShares = Math.floor((opts.sizeUsd / sig.entryPrice) * 100) / 100;
  const shares = Math.min(Math.max(rawShares, opts.minShares), opts.maxShares);
  const entryPrice =
    sig.orderMode === 'taker'
      ? Math.min(0.99, sig.entryPrice + opts.takerBufferCents / 100)
      : sig.entryPrice;
  return {
    strategy: sig.strategy,
    entryT: nowSec,
    entryPrice,
    shares,
    direction: sig.direction,
    orderMode: sig.orderMode,
    roundAgeSec,
  };
}

export function backtestFromTicks(
  rounds: TickRound[],
  opts: TickBacktestOptions
): BacktestResult {
  const notes: string[] = [];
  const strategy = opts.strategy;

  notes.push(
    'Evaluation clock = union of both sides\' trade prints; prices carry forward between prints.'
  );
  notes.push(
    'Fill price = the traded print at evaluation time. No orderbook depth, so size impact and queue position are not modelled.'
  );

  if (strategy === 'momentum') {
    if (!opts.spot || opts.spot.length === 0) {
      return {
        strategy,
        tier: 'not_testable',
        notes: [
          ...notes,
          'momentum requires a spot series (--spot binance:BTCUSDT); none supplied.',
        ],
        roundsConsidered: rounds.length,
        roundsWithData: 0,
        trades: [],
        metrics: emptyMetrics(),
      };
    }
    notes.push(
      'Spread gate (book.spreadPct <= 2.0) NOT applied \u2014 prints carry no quotes, so a spread cannot be derived.'
    );
    notes.push(
      'Spot = Binance 1s spot, a PROXY for the Chainlink TWAP these markets settle on. Same 30s windows are highly correlated but not identical.'
    );
    notes.push(
      'Live orderMode is maker_then_taker; charged as taker here because maker fills cannot be assumed without queue data.'
    );
  } else if (strategy === 'mean_reversion') {
    notes.push('OBI gate NOT applied \u2014 order-flow imbalance needs quotes, not prints.');
  } else {
    notes.push('spreadPct gate NOT applied \u2014 prints carry no quotes.');
  }

  const usable = rounds.filter((r) => r.up.length + r.down.length >= 20);

  // Flatten the spot series into parallel arrays once; rounds consume it by cursor.
  const spotTimes: number[] = [];
  const spotPrices: number[] = [];
  for (const p of opts.spot ?? []) {
    spotTimes.push(p.t);
    spotPrices.push(p.p);
  }
  const spotIndex = { times: spotTimes, prices: spotPrices };

  const trades: SimTrade[] = [];
  for (const r of usable) {
    const t = replayTickRound(r, opts, spotIndex);
    if (t) trades.push({ ...t, strategy });
  }

  const notionalUsd = trades.reduce((s, t) => s + t.entryPrice * t.shares, 0);
  const grossPnlUsd = trades.reduce((s, t) => s + t.grossPnlUsd, 0);
  const feesUsd = trades.reduce((s, t) => s + t.feesUsd, 0);
  const netPnlUsd = trades.reduce((s, t) => s + t.netPnlUsd, 0);
  const wins = trades.filter((t) => t.netPnlUsd > 0).length;

  if (rounds.length - usable.length > 0) {
    notes.push(`${rounds.length - usable.length}/${rounds.length} rounds had <20 ticks and were skipped.`);
  }

  return {
    strategy,
    tier: trades.length === 0 ? 'not_testable' : 'faithful',
    notes,
    roundsConsidered: rounds.length,
    roundsWithData: usable.length,
    trades,
    metrics: {
      trades: trades.length,
      wins,
      winRate: trades.length ? wins / trades.length : 0,
      grossPnlUsd,
      feesUsd,
      netPnlUsd,
      returnOnNotionalPct: notionalUsd > 0 ? (netPnlUsd / notionalUsd) * 100 : 0,
      notionalUsd,
      avgTradePct: notionalUsd > 0 ? (netPnlUsd / notionalUsd) * 100 : 0,
      bestTradeUsd: trades.length ? Math.max(...trades.map((t) => t.netPnlUsd)) : 0,
      worstTradeUsd: trades.length ? Math.min(...trades.map((t) => t.netPnlUsd)) : 0,
      netPnlIfNoFeesUsd: grossPnlUsd,
    },
  };
}

function emptyMetrics(): BacktestResult['metrics'] {
  return {
    trades: 0,
    wins: 0,
    winRate: 0,
    grossPnlUsd: 0,
    feesUsd: 0,
    netPnlUsd: 0,
    returnOnNotionalPct: 0,
    notionalUsd: 0,
    avgTradePct: 0,
    bestTradeUsd: 0,
    worstTradeUsd: 0,
    netPnlIfNoFeesUsd: 0,
  };
}

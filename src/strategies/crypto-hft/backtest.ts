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

/** Same semantics as `createPriceBuffer`, but every window takes an explicit `now`. */
export function createPurePriceBuffer(maxAgeSec = 180): PurePriceBuffer {
  // newest first, mirroring the live implementation
  const prices: PricePoint[] = [];

  function prune(now: number) {
    const cutoff = now - maxAgeSec * 1000;
    while (prices.length > 0 && prices[prices.length - 1].t < cutoff) prices.pop();
    if (prices.length > 2000) prices.length = 2000;
  }

  function inWindow(windowSec: number, now: number): PricePoint[] {
    const cutoff = now - windowSec * 1000;
    return prices.filter((p) => p.t >= cutoff);
  }

  return {
    push(price, ts) {
      prices.unshift({ t: ts, p: price });
      prune(ts);
    },
    reversals(windowSec, minStep, now) {
      const w = inWindow(windowSec, now);
      if (w.length < 3) return 0;
      let count = 0;
      let lastDir: 'up' | 'down' | null = null;
      for (let i = 1; i < w.length; i++) {
        const diff = w[i - 1].p - w[i].p;
        if (Math.abs(diff) < minStep) continue;
        const dir = diff > 0 ? 'up' : 'down';
        if (lastDir && dir !== lastDir) count++;
        lastDir = dir;
      }
      return count;
    },
    range(windowSec, now) {
      const w = inWindow(windowSec, now);
      if (w.length === 0) return 0;
      return Math.max(...w.map((x) => x.p)) - Math.min(...w.map((x) => x.p));
    },
    mean(windowSec, now) {
      const w = inWindow(windowSec, now);
      if (w.length === 0) return 0;
      return w.reduce((s, x) => s + x.p, 0) / w.length;
    },
    movePct(windowSec, now) {
      const w = inWindow(windowSec, now);
      if (w.length < 2) return 0;
      const newest = w[0].p;
      const oldest = w[w.length - 1].p;
      if (oldest === 0) return 0;
      return ((newest - oldest) / oldest) * 100;
    },
    count: () => prices.length,
  };
}

// =============================================================================
// STRATEGY PORTS (pure, no Date.now)
// =============================================================================

export type Direction = 'up' | 'down';

export interface Signal {
  strategy: 'mean_reversion' | 'expiry_fade';
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
  strategy: Signal['strategy'];
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
  strategy: Signal['strategy'];
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
  strategy: Signal['strategy'],
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
    strategy: Signal['strategy'];
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
  round: HistoricalRound,
  open: { strategy: Signal['strategy']; entryT: number; entryPrice: number; shares: number; direction: Direction; orderMode: Signal['orderMode']; roundAgeSec: number },
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
  strategy: Signal['strategy'],
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

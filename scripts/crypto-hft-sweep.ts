/**
 * Threshold sensitivity sweep for the crypto-hft strategies.
 *
 * WHY: "expiry_fade loses money" and "expiry_fade's trigger is too permissive"
 * are different diagnoses with different fixes. The second is testable — tighten
 * the entry thresholds and see whether the losses concentrate in the marginal
 * signals. If no threshold setting turns it positive, the edge is absent rather
 * than merely mistuned.
 *
 *   npx tsx scripts/crypto-hft-sweep.ts --asset btc --duration 15m --strategy expiry_fade
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  backtestFromTicks,
  loadSpotSeries,
  DEFAULT_BT_CONFIG,
  type ExpiryFadeCfg,
  type MeanReversionCfg,
  type MomentumCfg,
  type SpotPoint,
  type StrategyName,
  type TickRound,
} from '../src/strategies/crypto-hft/backtest';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface Row {
  label: string;
  trades: number;
  winRate: number;
  net: number;
  perTrade: number;
  fees: number;
}

function fmt(rows: Row[], title: string): void {
  console.log(`\n=== ${title} ===`);
  console.log(
    '  ' +
      'setting'.padEnd(34) +
      'trades'.padStart(7) +
      'win%'.padStart(7) +
      'net$'.padStart(9) +
      'perTrade'.padStart(10) +
      'fees$'.padStart(9)
  );
  for (const r of rows) {
    console.log(
      '  ' +
        r.label.padEnd(34) +
        String(r.trades).padStart(7) +
        (r.winRate * 100).toFixed(1).padStart(7) +
        r.net.toFixed(2).padStart(9) +
        r.perTrade.toFixed(3).padStart(10) +
        r.fees.toFixed(2).padStart(9)
    );
  }
}

async function main() {
  const asset = arg('asset', 'btc').toLowerCase();
  const duration = arg('duration', '15m');
  const only = arg('strategy', 'all');

  const path = join(process.cwd(), '.cache', 'crypto-hft', `${asset}-${duration}.jsonl`);
  if (!existsSync(path)) {
    console.error(`no tape cache at ${path} — run the backfill first`);
    process.exit(2);
  }
  const rounds: TickRound[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rounds.push(JSON.parse(line) as TickRound);
    } catch {
      /* skip */
    }
  }
  rounds.sort((a, b) => a.startSec - b.startSec);
  const usable = rounds.filter((r) => r.up.length + r.down.length >= 20);

  const first = rounds[0].startSec;
  const last = rounds[rounds.length - 1].endSec;
  const spot: SpotPoint[] = await loadSpotSeries(
    'BTCUSDT',
    first,
    last,
    join(process.cwd(), '.cache', 'crypto-hft')
  );

  console.log(`\n${asset.toUpperCase()} ${duration}: ${usable.length} usable rounds, ${spot.length.toLocaleString()} spot points`);
  console.log(
    `window: ${new Date(first * 1000).toISOString().slice(0, 10)} .. ${new Date(last * 1000).toISOString().slice(0, 10)}`
  );

  const run = (strategy: StrategyName, cfg: any): Row & { label: string } => {
    const r = backtestFromTicks(usable, { ...DEFAULT_BT_CONFIG, strategy, spot, strategyCfg: cfg });
    const m = r.metrics;
    return {
      label: '',
      trades: m.trades,
      winRate: m.winRate,
      net: m.netPnlUsd,
      perTrade: m.trades ? m.netPnlUsd / m.trades : 0,
      fees: m.feesUsd,
    };
  };

  // ── expiry_fade sensitivity ──────────────────────────────────────────────
  if (only === 'all' || only === 'expiry_fade') {
    const rows: Row[] = [];
    const push = (label: string, cfg: { expiryFade?: Partial<ExpiryFadeCfg> }) => {
      const r = run('expiry_fade', cfg);
      rows.push({ ...r, label });
    };

    push('baseline (live defaults)', {});

    // Require a larger skew from 0.50 before treating it as underpriced.
    for (const skew of [0.20, 0.25, 0.30, 0.35]) {
      push(`minSkewFromMid=${skew.toFixed(2)}`, { expiryFade: { minSkewFromMid: skew } });
    }
    // Trade only the very end of the round.
    for (const mn of [120, 180, 240]) {
      push(`minSecLeft=${mn}`, { expiryFade: { minSecLeft: mn } });
    }
    // Require a flatter spot tape.
    for (const move of [0.02, 0.04]) {
      push(`maxRecentSpotMovePct=${move}`, { expiryFade: { maxRecentSpotMovePct: move } });
    }
    // Combinations: tighter skew + later entry.
    for (const skew of [0.25, 0.30]) {
      for (const mn of [180, 240]) {
        push(`skew=${skew} minSecLeft=${mn}`, {
          expiryFade: { minSkewFromMid: skew, minSecLeft: mn },
        });
      }
    }
    fmt(rows, `expiry_fade threshold sensitivity (${usable.length} rounds)`);
    const best = rows.slice().sort((a, b) => b.net - a.net)[0];
    const base = rows[0];
    console.log(
      `\n  baseline net $${base.net.toFixed(2)} over ${base.trades} trades  ->  ` +
        `best $${best.net.toFixed(2)} (${best.label}) over ${best.trades} trades`
    );
    console.log(
      best.net > 0
        ? '  VERDICT: a threshold setting turns it positive — the trigger was too permissive.'
        : '  VERDICT: no setting is positive — the edge is absent, not merely mistuned.'
    );
  }

  // ── momentum sensitivity ─────────────────────────────────────────────────
  if (only === 'all' || only === 'momentum') {
    const rows: Row[] = [];
    const push = (label: string, cfg: { momentum?: Partial<MomentumCfg> }) => {
      const r = run('momentum', cfg);
      rows.push({ ...r, label });
    };
    push('baseline (live defaults)', {});
    for (const mv of [0.10, 0.12, 0.20, 0.25]) {
      push(`minSpotMovePct=${mv.toFixed(2)}`, { momentum: { minSpotMovePct: mv } });
    }
    for (const lag of [0.01, 0.03, 0.05]) {
      push(`minLagCents=${lag.toFixed(2)}`, { momentum: { minLagCents: lag } });
    }
    for (const stale of [2, 10, 20]) {
      push(`maxPolyStaleSec=${stale}`, { momentum: { maxPolyStaleSec: stale } });
    }
    fmt(rows, `momentum threshold sensitivity (${usable.length} rounds)`);
  }

  // ── mean_reversion sensitivity ───────────────────────────────────────────
  if (only === 'all' || only === 'mean_reversion') {
    const rows: Row[] = [];
    const push = (label: string, cfg: { meanReversion?: Partial<MeanReversionCfg> }) => {
      const r = run('mean_reversion', cfg);
      rows.push({ ...r, label });
    };
    push('baseline (live defaults)', {});
    for (const cheap of [0.20, 0.25, 0.35, 0.40]) {
      push(`cheapThreshold=${cheap.toFixed(2)}`, { meanReversion: { cheapThreshold: cheap } });
    }
    for (const exp of [0.65, 0.80, 0.85]) {
      push(`expensiveThreshold=${exp.toFixed(2)}`, { meanReversion: { expensiveThreshold: exp } });
    }
    for (const age of [60, 180, 300]) {
      push(`minRoundAgeSec=${age}`, { meanReversion: { minRoundAgeSec: age } });
    }
    fmt(rows, `mean_reversion threshold sensitivity (${usable.length} rounds)`);
  }

  console.log(
    '\nNote: per-trade net is the number to compare across settings — total net\n' +
      'favours high-frequency settings. Fill = traded print; no orderbook depth.\n'
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

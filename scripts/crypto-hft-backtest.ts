#!/usr/bin/env npx tsx
/**
 * Standalone runner for the crypto-hft round-driven backtester.
 *
 *   npx tsx scripts/crypto-hft-backtest.ts [--asset btc] [--duration 15m] [--rounds 24]
 *
 * Pulls real historical rounds from Polymarket's public APIs (no credentials),
 * replays them, and prints net P&L after the correct taker fee model.
 *
 * Read the `note:` lines in the output before drawing conclusions — the data
 * source is 1-minute fidelity and has no orderbook, so some strategy gates
 * cannot be applied and are reported as such rather than silently faked.
 */

import {
  backtestStrategy,
  fetchRecentRounds,
  formatBacktestReport,
  DEFAULT_BT_CONFIG,
  type BacktestResult,
} from '../src/strategies/crypto-hft/backtest';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const asset = arg('asset', 'btc').toLowerCase();
  const duration = arg('duration', '15m');
  const limit = Number(arg('rounds', '24'));

  const durationSec: Record<string, number> = {
    '5m': 300,
    '15m': 900,
    '1h': 3600,
    '4h': 14400,
  };
  const roundDurationSec = durationSec[duration];
  if (!roundDurationSec) {
    console.error(`unsupported --duration ${duration}; use one of ${Object.keys(durationSec).join(', ')}`);
    process.exit(1);
  }

  const seriesSlug = `${asset}-up-or-down-${duration}`;
  const nowSec = Math.floor(Date.now() / 1000);

  console.log(
    `\nFetching up to ${limit} resolved ${asset.toUpperCase()} ${duration} rounds (series: ${seriesSlug})...`
  );
  const rounds = await fetchRecentRounds({
    asset,
    durationLabel: duration,
    roundDurationSec,
    limit,
    nowSec,
  });

  if (rounds.length === 0) {
    console.error('No resolved rounds with price history returned.');
    process.exit(2);
  }

  const withPoints = rounds.filter((r) => r.upSeries.length > 0);
  const ptCounts = withPoints.map((r) => r.upSeries.length);
  const spanSec =
    withPoints.length > 1
      ? withPoints[withPoints.length - 1].startSec - withPoints[0].startSec
      : 0;

  console.log(`\nRounds retrieved: ${rounds.length}  (with price points: ${withPoints.length})`);
  if (ptCounts.length) {
    console.log(
      `Points per round: min ${Math.min(...ptCounts)} / median ${ptCounts.sort((a, b) => a - b)[Math.floor(ptCounts.length / 2)]} / max ${Math.max(...ptCounts)}`
    );
  }
  console.log(`History span: ${(spanSec / 3600).toFixed(1)} hours`);
  const resolved = rounds.filter((r) => r.resolvedUp !== null).length;
  console.log(`Resolved rounds: ${resolved}/${rounds.length}`);
  const vol = rounds.reduce((s, r) => s + r.volumeUsd, 0);
  console.log(`Total round volume: $${vol.toFixed(0)}  (avg $${(vol / rounds.length).toFixed(0)}/round)`);

  const results: BacktestResult[] = [];
  for (const strategy of ['expiry_fade', 'mean_reversion'] as const) {
    results.push(backtestStrategy(rounds, strategy, DEFAULT_BT_CONFIG));
    // Same run with fees disabled, purely to isolate how much fees decide the outcome.
    const noFee = backtestStrategy(rounds, strategy, { ...DEFAULT_BT_CONFIG, applyFees: false });
    results.push({ ...noFee, strategy: `${strategy}_NO_FEES` as BacktestResult['strategy'] });
  }

  console.log(formatBacktestReport(results));

  const feeSensitive = results.filter((r) => r.strategy === 'expiry_fade');
  if (feeSensitive.length >= 2) {
    const [withFee, noFee] = feeSensitive;
    const swing = noFee.metrics.netPnlUsd - withFee.metrics.netPnlUsd;
    console.log(
      `\n>>> expiry_fade: fees swing the result by $${swing.toFixed(2)} over ${withFee.metrics.trades} trades ` +
        `(${withFee.metrics.trades ? (swing / withFee.metrics.trades).toFixed(3) : '0'} per trade).`
    );
  }

  console.log(
    '\nCAVEATS: 1-minute fidelity, no historical orderbook, spot proxied by mid-price drift.\n' +
      'penny_clipper and momentum are NOT testable from this data source (see backtest.ts header).\n'
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Tick-level backtest runner for crypto-hft.
 *
 * Reads the tape cache produced by scripts/crypto-hft-backfill.ts and replays each
 * round at trade-print granularity, which is what makes `momentum` testable at all
 * (it needs 30s spot windows; the 1-minute prices-history path cannot express them).
 *
 *   # 1) collect data
 *   npx tsx scripts/crypto-hft-backfill.ts --asset btc --duration 15m --days 7
 *   # 2) replay it
 *   npx tsx scripts/crypto-hft-backtest-ticks.ts --asset btc --duration 15m
 *   npx tsx scripts/crypto-hft-backtest-ticks.ts --asset btc --duration 15m --no-spot
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  backtestFromTicks,
  loadSpotSeries,
  formatBacktestReport,
  DEFAULT_BT_CONFIG,
  type BacktestResult,
  type SpotPoint,
  type StrategyName,
  type TickRound,
} from '../src/strategies/crypto-hft/backtest';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Binance symbol for each Polymarket short-duration asset. */
const SPOT_SYMBOL: Record<string, string> = {
  btc: 'BTCUSDT',
  eth: 'ETHUSDT',
  sol: 'SOLUSDT',
  xrp: 'XRPUSDT',
  doge: 'DOGEUSDT',
  zec: 'ZECUSDT',
};

async function main() {
  const asset = arg('asset', 'btc').toLowerCase();
  const duration = arg('duration', '15m');
  const minTicks = Number(arg('min-ticks', '20'));
  const wantSpot = !flag('no-spot');
  const spotSymbol = arg('spot-symbol', SPOT_SYMBOL[asset] ?? '');

  const path = join(process.cwd(), '.cache', 'crypto-hft', `${asset}-${duration}.jsonl`);
  if (!existsSync(path)) {
    console.error(`No tape cache at ${path}\nRun: npx tsx scripts/crypto-hft-backfill.ts --asset ${asset} --duration ${duration} --days 7`);
    process.exit(2);
  }

  const rounds: TickRound[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rounds.push(JSON.parse(trimmed) as TickRound);
    } catch {
      /* skip corrupt line */
    }
  }
  rounds.sort((a, b) => a.startSec - b.startSec);

  if (rounds.length === 0) {
    console.error('Tape cache is empty.');
    process.exit(2);
  }

  const usable = rounds.filter((r) => r.up.length + r.down.length >= minTicks);
  const ticks = usable.reduce((s, r) => s + r.up.length + r.down.length, 0);
  const first = rounds[0].startSec;
  const last = rounds[rounds.length - 1].endSec;

  console.log(`\n${'='.repeat(74)}`);
  console.log(`TICK-LEVEL BACKTEST  ${asset.toUpperCase()} ${duration}`);
  console.log(`${'='.repeat(74)}`);
  console.log(`rounds in cache : ${rounds.length}  (usable >=${minTicks} ticks: ${usable.length})`);
  console.log(`total prints    : ${ticks.toLocaleString()}   avg ${Math.round(ticks / Math.max(usable.length, 1))}/round`);
  console.log(
    `window          : ${new Date(first * 1000).toISOString().slice(0, 16)} .. ` +
      `${new Date(last * 1000).toISOString().slice(0, 16)}  (${((last - first) / 86400).toFixed(2)} days)`
  );
  console.log(`resolved        : ${usable.filter((r) => r.resolvedUp !== null).length}/${usable.length}`);
  const vol = usable.reduce((s, r) => s + r.volumeUsd, 0);
  console.log(`round volume    : $${vol.toLocaleString(undefined, { maximumFractionDigits: 0 })} (avg $${Math.round(vol / Math.max(usable.length, 1))}/round)`);

  // 鈹€鈹€ spot series (needed for momentum) 鈹€鈹€
  let spot: SpotPoint[] | undefined;
  if (wantSpot && spotSymbol) {
    const cacheDir = join(process.cwd(), '.cache', 'crypto-hft');
    process.stdout.write(`\nloading ${spotSymbol} 1s spot for the window... `);
    const t0 = Date.now();
    spot = await loadSpotSeries(spotSymbol, first, last, cacheDir, (n) =>
      process.stdout.write(`\r  ${spotSymbol} spot: ${n.toLocaleString()} points...          `)
    );
    process.stdout.write('\r' + ' '.repeat(70) + '\r');
    console.log(`${spotSymbol} spot: ${spot.length.toLocaleString()} points in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (spot.length === 0) {
      console.log('  (spot fetch returned nothing 鈥?momentum will be reported as not_testable)');
      spot = undefined;
    }
  }

  const strategies: StrategyName[] = ['momentum', 'expiry_fade', 'mean_reversion'];
  const results: BacktestResult[] = [];
  for (const strategy of strategies) {
    results.push(
      backtestFromTicks(usable, { ...DEFAULT_BT_CONFIG, strategy, spot, trustPrintAsFill: true })
    );
    const noFee = backtestFromTicks(usable, {
      ...DEFAULT_BT_CONFIG,
      strategy,
      spot,
      trustPrintAsFill: true,
      applyFees: false,
    });
    results.push({ ...noFee, strategy: `${strategy}_NO_FEES` as StrategyName });
  }

  console.log(formatBacktestReport(results));

  // 鈹€鈹€ verdict 鈹€鈹€
  console.log(`\n${'='.repeat(74)}`);
  console.log('VERDICT (net of the corrected Polymarket taker fee)');
  console.log(`${'='.repeat(74)}`);
  for (const strategy of strategies) {
    const r = results.find((x) => x.strategy === strategy)!;
    const noFee = results.find((x) => x.strategy === `${strategy}_NO_FEES`)!;
    if (r.tier === 'not_testable') {
      console.log(`  ${strategy.padEnd(16)} NOT TESTABLE 鈥?${r.notes[r.notes.length - 1] ?? ''}`);
      continue;
    }
    const m = r.metrics;
    const perTrade = m.trades ? m.netPnlUsd / m.trades : 0;
    const verdict = m.netPnlUsd > 0 ? 'PROFITABLE' : 'LOSS-MAKING';
    console.log(
      `  ${strategy.padEnd(16)} ${verdict.padEnd(12)} net $${m.netPnlUsd.toFixed(2)} ` +
        `over ${m.trades} trades ($${perTrade.toFixed(3)}/trade)  ` +
        `fees $${m.feesUsd.toFixed(2)}  fees-off $${noFee.metrics.netPnlUsd.toFixed(2)}`
    );
  }
  console.log(
    '\nReminder: fill price = traded print; no orderbook depth, so size impact and\n' +
      'queue position are unmodelled, and momentum uses Binance spot as a proxy for\n' +
      'the Chainlink TWAP these markets actually settle on.\n'
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

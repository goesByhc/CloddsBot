/**
 * Are the momentum entries real mispricings, or stale/isolated prints?
 *
 * The entry-price distribution has p10 = 0.050 on every asset, which is exactly
 * the kind of pattern a clipped or lonesome print produces. If entries are filling
 * at prices that were not actually available, the apparent edge is an artefact of
 * the print-as-fill assumption rather than a mispricing.
 *
 *   npx tsx scripts/diag-entry-fills.ts --asset btc --duration 15m
 */
import { readFileSync } from 'fs';
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

async function main() {
  const asset = arg('asset', 'btc').toLowerCase();
  const duration = arg('duration', '15m');
  const maxRounds = Number(arg('rounds', '1500'));

  const path = join(process.cwd(), '.cache', 'crypto-hft', `${asset}-${duration}.jsonl`);
  const all: TickRound[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      all.push(JSON.parse(line) as TickRound);
    } catch {
      /* skip */
    }
  }
  all.sort((a, b) => a.startSec - b.startSec);
  const rounds = all.filter((r) => r.up.length + r.down.length >= 20).slice(-maxRounds);
  const spot: SpotPoint[] = await loadSpotSeries(
    SPOT_SYMBOL[asset],
    rounds[0].startSec,
    rounds[rounds.length - 1].endSec,
    join(process.cwd(), '.cache', 'crypto-hft')
  );

  const entries = collectEntries(rounds, { ...DEFAULT_BT_CONFIG, strategy: 'momentum', spot });
  const bySlug = new Map(rounds.map((r) => [r.slug, r]));

  console.log(`\n${asset.toUpperCase()}: ${entries.length} momentum entries\n`);
  console.log(
    '  entryPx  nRecip  nPrev30s  lastTradeAge  side  size  sharesToFill5  gapC'
  );

  let thin = 0;
  let isolated = 0;
  const samples: Array<{ px: number; recips: number; age: number; size: number }> = [];

  for (const e of entries) {
    const r = bySlug.get(e.roundSlug)!;
    const series = e.direction === 'up' ? r.up : r.down;

    // How many prints occurred at/near the entry price in the round?
    const recips = series.filter((x) => Math.abs(x.p - e.entryPrice) < 1e-9).length;
    // Prints in the 30s before entry.
    const prior = series.filter((x) => x.t >= e.t - 30 && x.t < e.t).length;
    // Age of the last print at or before entry.
    const before = series.filter((x) => x.t <= e.t);
    const age = before.length ? e.t - before[before.length - 1].t : -1;
    // Shares needed for the standard $20 notional.
    const sharesToFill = 20 / Math.max(e.entryPrice, 1e-9);

    samples.push({ px: e.entryPrice, recips, age, size: sharesToFill });
    if (recips <= 2) thin++;
    if (age > 10) isolated++;

    if (samples.length <= 14) {
      console.log(
        `  ${e.entryPrice.toFixed(3)}   ${String(recips).padStart(3)}     ${String(prior).padStart(4)}       ` +
          `${String(age).padStart(4)}s      ${e.direction.padEnd(4)}  n/a    ${sharesToFill.toFixed(0).padStart(6)}       ${e.gapCents.toFixed(1)}`
      );
    }
  }

  const px = samples.map((s) => s.px).sort((a, b) => a - b);
  const q = (f: number) => px[Math.min(px.length - 1, Math.floor(px.length * f))];
  console.log(`\n  entry price p05=${q(0.05).toFixed(3)} p25=${q(0.25).toFixed(3)} p50=${q(0.5).toFixed(3)} p75=${q(0.75).toFixed(3)} p95=${q(0.95).toFixed(3)}`);
  console.log(`  exact-price repeats <=2 in round : ${thin}/${entries.length}`);
  console.log(`  last print older than 10s at entry: ${isolated}/${entries.length}`);
  const tiny = samples.filter((s) => s.px <= 0.10).length;
  console.log(`  entries at price <= 0.05-ish zone: ${tiny}/${entries.length}`);
  console.log(
    `\n  Interpretation: if most entries have several prints at the same price and a\n` +
      `  fresh last print, the price was genuinely available. A cluster at p05 with\n` +
      `  few repeats and stale prints would indicate an unfillable artefact.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

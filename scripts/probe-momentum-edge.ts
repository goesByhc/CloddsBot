/**
 * Probe: is the momentum edge real, or an artefact of the backtest's fill model?
 *
 * WHY THIS EXISTS
 * ---------------
 * `backtestFromTicks` reports realised P&L, which cannot distinguish:
 *
 *   (A) REAL EDGE     - the entry price is genuinely stale and converges toward the
 *                       spot-implied level after entry.
 *   (B) FILL ARTEFACT - the entry is filled at the last trade, a price the signal
 *                       partly predates; the "profit" is the assumption, not a fact.
 *
 * Both produce identical P&L. This probe measures the PATH instead, using the real
 * entries from `collectEntries` (identical predicate to the backtest, so the
 * cohorts match exactly), plus a control cohort sampled at arbitrary instants so
 * that ordinary price drift cannot be mistaken for edge.
 *
 *   npx tsx scripts/probe-momentum-edge.ts --asset sol --duration 15m
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  collectEntries,
  loadSpotSeries,
  DEFAULT_BT_CONFIG,
  type EntryObservation,
  type SpotPoint,
  type TickRound,
} from '../src/strategies/crypto-hft/backtest';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SPOT_SYMBOL: Record<string, string> = {
  btc: 'BTCUSDT',
  eth: 'ETHUSDT',
  sol: 'SOLUSDT',
  xrp: 'XRPUSDT',
};

/** Control cohort: arbitrary instants, same rounds and same grids, no signal. */
function collectControl(rounds: TickRound[], stepSec: number): EntryObservation[] {
  const out: EntryObservation[] = [];
  for (const round of rounds) {
    if (round.up.length + round.down.length < 20) continue;
    const times = Array.from(
      new Set([...round.up.map((x) => x.t), ...round.down.map((x) => x.t)])
    ).sort((a, b) => a - b);
    if (times.length < 3) continue;

    const upSeries = round.up;
    const downSeries = round.down;

    for (const t of times) {
      const roundAgeSec = t - round.startSec;
      const timeLeftSec = round.endSec - t;
      if (roundAgeSec < 30 || timeLeftSec < 130) continue;
      if (roundAgeSec % stepSec !== 0) continue;

      // Pick a side at deterministic pseudo-random from the timestamp, so the
      // control is not systematically long the eventual winner.
      const dir: 'up' | 'down' = (t * 2654435761) % 2 === 0 ? 'up' : 'down';
      const series = dir === 'up' ? upSeries : downSeries;
      let entry: number | null = null;
      for (const x of series) {
        if (x.t > t) break;
        if (x.t <= t) entry = x.p;
      }
      if (entry === null) continue;

      const forward: Record<number, number | null> = {};
      for (const h of [15, 30, 60, 120, 300]) {
        let v: number | null = null;
        for (const x of series) {
          if (x.t > t + h) break;
          if (x.t >= t) v = x.p;
        }
        forward[h] = v;
      }

      out.push({
        roundSlug: round.slug,
        t,
        direction: dir,
        entryPrice: entry,
        expectedPrice: entry,
        gapCents: 0,
        spotMovePct: 0,
        forward,
        finalPrice:
          round.resolvedUp === null
            ? null
            : dir === 'up'
              ? round.resolvedUp >= 0.5
                ? 1
                : 0
              : round.resolvedUp >= 0.5
                ? 0
                : 1,
      });
    }
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function report(title: string, s: EntryObservation[]) {
  if (s.length === 0) {
    console.log(`\n=== ${title} ===\n  no samples`);
    return;
  }
  const moves = (h: number) =>
    s
      .filter((x) => x.forward[h] !== null)
      .map((x) => (x.forward[h]! - x.entryPrice) * 100);

  const won = s.filter((x) => x.finalPrice === 1).length;
  const resolved = s.filter((x) => x.finalPrice !== null).length;
  const toFinal = s
    .filter((x) => x.finalPrice !== null)
    .map((x) => (x.finalPrice! - x.entryPrice) * 100);

  console.log(`\n=== ${title} ===`);
  console.log(`  samples                        : ${s.length}`);
  console.log(`  mean entry gap vs spot-implied : ${mean(s.map((x) => x.gapCents)).toFixed(2)}c`);
  console.log(`  median entry price             : ${median(s.map((x) => x.entryPrice)).toFixed(3)}`);
  console.log(`  --- price change after entry (cents, + = traded side rose) ---`);
  for (const h of [15, 30, 60, 120, 300]) {
    const m = moves(h);
    if (m.length) console.log(`    +${String(h).padStart(3)}s : mean ${mean(m).toFixed(2).padStart(7)}   n=${m.length}`);
  }
  console.log(`    final: mean ${mean(toFinal).toFixed(2)}   n=${toFinal.length}`);
  console.log(
    `  traded side won                : ${won}/${resolved} (${resolved ? ((won / resolved) * 100).toFixed(1) : 'n/a'}%)`
  );
}

async function main() {
  const asset = arg('asset', 'btc').toLowerCase();
  const duration = arg('duration', '15m');
  const strategy = arg('strategy', 'momentum') as 'momentum' | 'expiry_fade' | 'mean_reversion';
  const maxRounds = Number(arg('rounds', '1500'));
  const spotSymbol = SPOT_SYMBOL[asset];

  const path = join(process.cwd(), '.cache', 'crypto-hft', `${asset}-${duration}.jsonl`);
  if (!existsSync(path)) {
    console.error(`no tape cache at ${path}`);
    process.exit(2);
  }
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

  const first = rounds[0].startSec;
  const last = rounds[rounds.length - 1].endSec;
  console.log(`\n${asset.toUpperCase()} ${duration}  strategy=${strategy}  rounds=${rounds.length}`);
  console.log(
    `window: ${new Date(first * 1000).toISOString().slice(0, 16)} .. ${new Date(last * 1000).toISOString().slice(0, 16)}`
  );

  const spot: SpotPoint[] = await loadSpotSeries(
    spotSymbol,
    first,
    last,
    join(process.cwd(), '.cache', 'crypto-hft')
  );
  console.log(`spot: ${spot.length.toLocaleString()} points`);

  const flagged = collectEntries(rounds, { ...DEFAULT_BT_CONFIG, strategy, spot });
  const control = collectControl(rounds, 30);

  report(`FLAGGED  (real ${strategy} entries - identical predicate to the backtest)`, flagged);
  report('CONTROL  (same rounds/grids, side chosen pseudo-randomly)', control);

  // ── interpretation ──
  if (flagged.length > 0) {
    const gap = mean(flagged.map((x) => x.gapCents));
    const m30 = mean(
      flagged.filter((x) => x.forward[30] !== null).map((x) => (x.forward[30]! - x.entryPrice) * 100)
    );
    const ctrl30 = mean(
      control.filter((x) => x.forward[30] !== null).map((x) => (x.forward[30]! - x.entryPrice) * 100)
    );
    const wonF = flagged.filter((x) => x.finalPrice === 1).length;
    const resF = flagged.filter((x) => x.finalPrice !== null).length;
    const wonC = control.filter((x) => x.finalPrice === 1).length;
    const resC = control.filter((x) => x.finalPrice !== null).length;

    console.log(`\n${'='.repeat(72)}`);
    console.log('INTERPRETATION');
    console.log(`${'='.repeat(72)}`);
    console.log(
      `  mean gap at entry      : ${gap.toFixed(2)}c\n` +
        `  +30s move (flagged)    : ${m30.toFixed(2)}c\n` +
        `  +30s move (control)    : ${ctrl30.toFixed(2)}c\n` +
        `  win rate flagged       : ${resF ? ((wonF / resF) * 100).toFixed(1) : 'n/a'}%  (n=${resF})\n` +
        `  win rate control       : ${resC ? ((wonC / resC) * 100).toFixed(1) : 'n/a'}%  (n=${resC})`
    );
    const edgeVsControl = (wonF / Math.max(resF, 1) - wonC / Math.max(resC, 1)) * 100;
    console.log(
      `  flagged win rate minus control: ${edgeVsControl >= 0 ? '+' : ''}${edgeVsControl.toFixed(1)} pp`
    );
    console.log(
      '\n  Reading: if the flagged cohort\'s price moves TOWARD the spot-implied level\n' +
        '  (positive +30s/+60s drift) AND its win rate exceeds the control\'s, the entry\n' +
        '  price was genuinely stale. If flagged and control behave the same, the\n' +
        '  backtest\'s edge is a fill artefact.'
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

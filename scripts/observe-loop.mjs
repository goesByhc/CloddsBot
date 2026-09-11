#!/usr/bin/env node
/**
 * Keep the tape current for rounds the order-book observer has recorded, then run
 * the join.
 *
 * The observer writes book snapshots for live rounds. Those rounds only enter the
 * trade tape once they have closed and been backfilled, and the analyzer needs both
 * sides to answer anything. Running this on a timer closes that loop unattended.
 *
 *   node scripts/observe-loop.mjs                 # backfill + analyse, once
 *   node scripts/observe-loop.mjs --every 1800     # repeat every 30 min
 *
 * Uses only the public APIs plus the local scripts; no credentials, no order path.
 */
import { spawnSync } from 'child_process';

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(`--${name}`);
}
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const assets = opt('assets', 'btc,eth,sol').split(',').map((s) => s.trim());
const duration = opt('duration', '15m');
const days = opt('days', '0.3');
const everySec = Number(opt('every', '0'));
const analyzer = 'scripts/analyze-orderbook.ts';
const backfill = 'scripts/crypto-hft-backfill.ts';

function run(title, file, rest) {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`);
  const r = spawnSync('npx', ['tsx', file, ...rest], { stdio: 'inherit', shell: true });
  return r.status === 0;
}

function cycle() {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\n##### cycle at ${stamp} UTC #####`);

  // 1) bring the tape up to date so live rounds can be joined.
  for (const a of assets) {
    run(
      `backfill ${a} ${duration} (last ${days}d)`,
      backfill,
      ['--asset', a, '--duration', duration, '--days', days, '--min-trades', '20', '--concurrency', '6']
    );
  }

  // 2) join books against tape and print the answer (or say there is not enough data).
  for (const a of assets) {
    run(`analyse ${a}`, analyzer, ['--asset', a, '--duration', duration, '--strategy', 'momentum']);
  }
}

cycle();

if (everySec > 0) {
  console.log(`\nrepeating every ${everySec}s (Ctrl-C to stop)`);
  setInterval(cycle, everySec * 1000);
}

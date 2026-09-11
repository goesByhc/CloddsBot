/**
 * Regression check: the optimised PriceBuffer must behave exactly like the
 * straightforward implementation it replaced, otherwise every backtest number
 * silently shifts. Compares against a reference implementation that uses the
 * original (slow) filter-based semantics.
 *
 *   npx tsx scripts/verify-buffer-equiv.ts
 */
import { createPurePriceBuffer } from '../src/strategies/crypto-hft/backtest';

/** Reference: the original filter-based implementation. */
function createReferenceBuffer(maxAgeSec = 180) {
  const prices: Array<{ t: number; p: number }> = [];
  function prune(now: number) {
    const cutoff = now - maxAgeSec * 1000;
    while (prices.length > 0 && prices[prices.length - 1].t < cutoff) prices.pop();
    if (prices.length > 2000) prices.length = 2000;
  }
  function inWindow(windowSec: number, now: number) {
    const cutoff = now - windowSec * 1000;
    return prices.filter((p) => p.t >= cutoff);
  }
  return {
    push(price: number, ts: number) {
      prices.unshift({ t: ts, p: price });
      prune(ts);
    },
    reversals(windowSec: number, minStep: number, now: number) {
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
    range(windowSec: number, now: number) {
      const w = inWindow(windowSec, now);
      if (w.length === 0) return 0;
      return Math.max(...w.map((x) => x.p)) - Math.min(...w.map((x) => x.p));
    },
    mean(windowSec: number, now: number) {
      const w = inWindow(windowSec, now);
      if (w.length === 0) return 0;
      return w.reduce((s, x) => s + x.p, 0) / w.length;
    },
    movePct(windowSec: number, now: number) {
      const w = inWindow(windowSec, now);
      if (w.length < 2) return 0;
      const newest = w[0].p;
      const oldest = w[w.length - 1].p;
      if (oldest === 0) return 0;
      return ((newest - oldest) / oldest) * 100;
    },
  };
}

// Deterministic pseudo-random walk so failures are reproducible.
//
// NOTE: timestamps must be strictly non-decreasing. Real trade prints arrive in
// time order, and the optimised buffer relies on that (it breaks a reverse scan
// at the first out-of-window point). An earlier version of this harness advanced
// time by a random step *from the previous value* but recomputed from `t0`, which
// produced out-of-order timestamps and reported 37,616 bogus mismatches.
let seed = 12345;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

const fast = createPurePriceBuffer();
const ref = createReferenceBuffer();

const t0 = 1_700_000_000_000;
let clock = t0;
let mismatches = 0;
let checked = 0;

for (let i = 0; i < 6000; i++) {
  // strictly increasing, with occasional larger gaps like real prints
  clock += 200 + Math.floor(rnd() * 900);
  const t = clock;
  const p = 0.2 + rnd() * 0.6;
  fast.push(p, t);
  ref.push(p, t);

  if (i % 3 !== 0) continue;
  for (const w of [5, 10, 30, 60, 120]) {
    checked += 4;
    const a = fast.movePct(w, t);
    const b = ref.movePct(w, t);
    if (Math.abs(a - b) > 1e-9) {
      console.log(`movePct(${w}) mismatch at i=${i}: fast=${a} ref=${b}`);
      mismatches++;
    }
    if (Math.abs(fast.range(w, t) - ref.range(w, t)) > 1e-9) {
      console.log(`range(${w}) mismatch at i=${i}`);
      mismatches++;
    }
    if (Math.abs(fast.mean(w, t) - ref.mean(w, t)) > 1e-9) {
      console.log(`mean(${w}) mismatch at i=${i}`);
      mismatches++;
    }
    if (fast.reversals(w, 0.01, t) !== ref.reversals(w, 0.01, t)) {
      console.log(
        `reversals(${w}) mismatch at i=${i}: fast=${fast.reversals(w, 0.01, t)} ref=${ref.reversals(w, 0.01, t)}`
      );
      mismatches++;
    }
  }
}

console.log(`\ncompared ${checked} values over 6000 pushes across 5 windows`);
console.log(mismatches === 0 ? 'IDENTICAL — optimisation is behaviour-preserving' : `${mismatches} MISMATCHES`);
process.exit(mismatches === 0 ? 0 : 1);

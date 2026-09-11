/**
 * Integrity check on the recorded order-book observations.
 *
 * Catches the failure modes that would silently corrupt the dataset:
 *   - duplicate records for the same (slug, side, timestamp)
 *   - a round still being polled after the round rolled over
 *   - incomplete poll cycles (fewer tokens than expected)
 *
 *   node scripts/check-orderbook-data.mjs [dir]
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const dir = process.argv[2] ?? join(process.cwd(), '.cache', 'orderbook');
if (!existsSync(dir)) {
  console.error(`no such directory: ${dir}`);
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.includes('-raw'));
if (files.length === 0) {
  console.error(`no .jsonl observation files in ${dir}`);
  process.exit(1);
}

let total = 0;
// Key MUST include asset. All three assets share the same slug (the slug comes from
// whichever asset resolved first), so a slug|side|ts key collapses three distinct
// records into one and reports false duplicates.
const seen = new Map(); // slug|asset|side|ts -> count
const perSlugSide = new Map(); // slug|asset|side -> stats
const perTs = new Map(); // ts -> count
const slugWindow = new Map(); // slug -> {min,max}
let malformed = 0;

for (const f of files) {
  const lines = readFileSync(join(dir, f), 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (!o.slug || !o.side || typeof o.ts !== 'number') {
      malformed++;
      continue;
    }
    total++;
    const k = `${o.slug}|${o.asset}|${o.side}|${o.ts}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
    perTs.set(o.ts, (perTs.get(o.ts) ?? 0) + 1);
    const ks = `${o.slug}|${o.asset}|${o.side}`;
    const cur = perSlugSide.get(ks);
    if (!cur) perSlugSide.set(ks, { minTs: o.ts, maxTs: o.ts, count: 1 });
    else {
      cur.minTs = Math.min(cur.minTs, o.ts);
      cur.maxTs = Math.max(cur.maxTs, o.ts);
      cur.count++;
    }
    const sw = slugWindow.get(o.slug);
    if (!sw) slugWindow.set(o.slug, { min: o.ts, max: o.ts, start: o.roundStart, end: o.roundEnd });
    else {
      sw.min = Math.min(sw.min, o.ts);
      sw.max = Math.max(sw.max, o.ts);
    }
  }
}

console.log(`files           : ${files.length}`);
console.log(`records         : ${total}`);
console.log(`malformed lines : ${malformed}`);

const dups = [...seen.entries()].filter(([, c]) => c > 1);
console.log(`duplicate keys  : ${dups.length}` + (dups.length ? '  <-- BUG' : '  (none)'));
for (const [k, c] of dups.slice(0, 5)) console.log(`    ${k} x${c}`);

// Poll-cycle completeness: each timestamp should carry one record per token.
const counts = new Map();
for (const [, c] of perTs) counts.set(c, (counts.get(c) ?? 0) + 1);
console.log(`distinct timestamps: ${perTs.size}`);
console.log(`records per timestamp:`);
for (const [c, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(c).padStart(3)} records -> ${n} timestamp(s)`);
}

console.log(`\nrounds covered: ${slugWindow.size}`);
let stalePolls = 0;
for (const [slug, w] of slugWindow) {
  const endMs = (w.end ?? 0) * 1000;
  const minMs = w.min * 1000;
  const maxMs = w.max * 1000;
  const afterEnd = w.end ? w.max - w.end : 0;
  if (afterEnd > 0) stalePolls++;
  console.log(
    `  ${slug}  start=${w.start} end=${w.end}  ` +
      `observed ${w.min}..${w.max}  ` +
      `span=${((maxMs - minMs) / 60000).toFixed(1)}m  afterRoundEnd=${afterEnd}s`
  );
}
console.log(
  `\nrounds polled after their end: ${stalePolls}` +
    (stalePolls ? '  <-- records beyond the round boundary' : '  (clean)')
);

const sides = new Set([...perSlugSide.keys()].map((k) => k.split('|')[1]));
console.log(`\ndistinct sides seen: ${[...sides].join(', ')}`);
const assets = new Set();
for (const k of perSlugSide.keys()) void k;
console.log(
  `\nverdict: ${dups.length === 0 && malformed === 0 && stalePolls === 0 ? 'CLEAN' : 'ISSUES FOUND'}`
);

#!/usr/bin/env node
/**
 * Generate a self-contained HTML status page for the order-book study.
 *
 * Writes .cache/orderbook/status.html with the data inlined, so it can be opened by
 * double-click - no server, no gateway, no network. Re-run it to refresh.
 *
 *   node scripts/observe-status-page.mjs
 *   start .cache/orderbook/status.html        # Windows
 *
 * Everything shown is derived from two local sources only:
 *   .cache/orderbook/*.jsonl     book observations from the recorder
 *   .cache/crypto-hft/*.jsonl    the trade tape
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const assets = opt('assets', 'btc,eth,sol').split(',').map((s) => s.trim());
const duration = opt('duration', '15m');
const bookDir = opt('dir', join(process.cwd(), '.cache', 'orderbook'));
const tapeDir = join(process.cwd(), '.cache', 'crypto-hft');
const outPath = join(bookDir, 'status.html');

/** Measured momentum entry rates (entries/day) and the <=0.05 share. */
const RATES = { btc: 1.35, eth: 9.4, sol: 18.3 };
const LOW_FRAC = 0.247;

function readJsonl(file) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)))];
}
function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// ── gather ──
const bookFiles = existsSync(bookDir)
  ? readdirSync(bookDir).filter((f) => f.endsWith('.jsonl') && !f.includes('-raw'))
  : [];
const allBooks = [];
for (const f of bookFiles) allBooks.push(...readJsonl(join(bookDir, f)));
allBooks.sort((a, b) => a.ts - b.ts);

const totalRecords = allBooks.length;
const seenKeys = new Set();
let duplicates = 0;
for (const b of allBooks) {
  const k = `${b.slug}|${b.asset}|${b.side}|${b.ts}`;
  if (seenKeys.has(k)) duplicates++;
  seenKeys.add(k);
}
const distinctTs = new Set(allBooks.map((b) => b.ts)).size;
const perTsCounts = new Map();
{
  const c = new Map();
  for (const b of allBooks) c.set(b.ts, (c.get(b.ts) ?? 0) + 1);
  for (const v of c.values()) perTsCounts.set(v, (perTsCounts.get(v) ?? 0) + 1);
}
const spanMin = totalRecords ? (allBooks[totalRecords - 1].ts - allBooks[0].ts) / 60 : 0;
const spanHours = spanMin / 60;

// Observer liveness: newest mtime across observation files.
let newestMtime = 0;
for (const f of bookFiles) {
  const m = statSync(join(bookDir, f)).mtimeMs;
  if (m > newestMtime) newestMtime = m;
}
const idleSec = newestMtime ? (Date.now() - newestMtime) / 1000 : null;
const live = idleSec !== null && idleSec < 60;

const byAsset = {};
for (const a of assets) {
  const books = allBooks.filter((b) => b.asset === a);
  const tapePath = join(tapeDir, `${a}-${duration}.jsonl`);
  const tape = existsSync(tapePath) ? readJsonl(tapePath) : [];
  tape.sort((x, y) => x.startSec - y.startSec);

  let tapeRounds = 0;
  let resolvedRounds = 0;
  if (books.length) {
    const firstMs = books[0].ts * 1000;
    const lastMs = books[books.length - 1].ts * 1000;
    const inSpan = tape.filter(
      (r) => r.endSec * 1000 >= firstMs && r.startSec * 1000 <= lastMs && r.up.length + r.down.length >= 20
    );
    tapeRounds = inSpan.length;
    resolvedRounds = inSpan.filter((r) => r.resolvedUp !== null).length;
  }

  const rate = RATES[a] ?? 0;
  const expectedAll = rate * (spanHours / 24);
  const expectedLow = expectedAll * LOW_FRAC;
  const daysTo10 = rate ? 10 / (rate * LOW_FRAC) : null;
  const daysTo25 = rate ? 25 / (rate * LOW_FRAC) : null;

  // Latest snapshot per side.
  const latest = {};
  for (const side of ['up', 'down']) {
    const arr = books.filter((b) => b.side === side);
    latest[side] = arr.length ? arr[arr.length - 1] : null;
  }

  byAsset[a] = {
    observations: books.length,
    distinctTimestamps: new Set(books.map((b) => b.ts)).size,
    roundsCovered: new Set(books.map((b) => b.slug)).size,
    tapeRounds,
    resolvedRounds,
    bestAsk: {
      p10: quantile(books.filter((b) => b.bestAsk !== null).map((b) => b.bestAsk), 0.1),
      p50: quantile(books.filter((b) => b.bestAsk !== null).map((b) => b.bestAsk), 0.5),
      p90: quantile(books.filter((b) => b.bestAsk !== null).map((b) => b.bestAsk), 0.9),
    },
    bookAgeMs: {
      p50: quantile(books.filter((b) => typeof b.bookAgeMs === 'number').map((b) => b.bookAgeMs), 0.5),
      p90: quantile(books.filter((b) => typeof b.bookAgeMs === 'number').map((b) => b.bookAgeMs), 0.9),
    },
    askDepthMedian: quantile(books.map((b) => b.askDepth), 0.5),
    rate,
    expectedAll,
    expectedLow,
    daysTo10,
    daysTo25,
    latest,
  };
}

const payload = {
  generatedAt: new Date().toISOString(),
  live,
  idleSec,
  totalRecords,
  duplicates,
  distinctTs,
  perTsCounts: [...perTsCounts.entries()].sort((a, b) => b[1] - a[1]),
  spanMin,
  spanHours,
  bookFiles: bookFiles.length,
  duration,
  assets,
  byAsset,
};

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Order-book study - status</title>
<style>
  :root { --bg:#0f1115; --card:#171a21; --line:#252a34; --fg:#e6e8ec; --mut:#8b93a3;
          --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; --acc:#60a5fa; }
  * { box-sizing:border-box; }
  body { margin:0; padding:28px 20px 60px; background:var(--bg); color:var(--fg);
         font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1080px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 4px; font-weight:650; letter-spacing:-.01em; }
  .sub { color:var(--mut); font-size:13px; margin-bottom:22px; }
  .grid { display:grid; gap:14px; }
  .g4 { grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); }
  .g2 { grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 18px; }
  .card h2 { font-size:12px; text-transform:uppercase; letter-spacing:.07em;
             color:var(--mut); margin:0 0 12px; font-weight:600; }
  .big { font-size:26px; font-weight:650; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
  .kv { display:flex; justify-content:space-between; gap:12px; padding:4px 0; font-size:13px; }
  .kv span:first-child { color:var(--mut); }
  .kv span:last-child { font-variant-numeric:tabular-nums; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:right; color:var(--mut); font-weight:600; font-size:11px;
       text-transform:uppercase; letter-spacing:.05em; padding:0 0 8px; }
  th:first-child { text-align:left; }
  td { text-align:right; padding:7px 0; border-top:1px solid var(--line);
       font-variant-numeric:tabular-nums; }
  td:first-child { text-align:left; font-weight:600; }
  .pill { display:inline-flex; align-items:center; gap:6px; padding:3px 10px;
          border-radius:999px; font-size:12px; font-weight:600; }
  .pill.ok { background:rgba(74,222,128,.13); color:var(--ok); }
  .pill.bad { background:rgba(248,113,113,.13); color:var(--bad); }
  .pill.warn { background:rgba(251,191,36,.13); color:var(--warn); }
  .dot { width:7px; height:7px; border-radius:50%; background:currentColor; }
  .muted { color:var(--mut); }
  .note { font-size:12px; color:var(--mut); margin-top:10px; line-height:1.5; }
  .bar { height:5px; background:var(--line); border-radius:3px; overflow:hidden; margin-top:8px; }
  .bar > i { display:block; height:100%; background:var(--acc); }
  code { background:#0b0d11; border:1px solid var(--line); border-radius:5px;
         padding:2px 6px; font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Order-book study &mdash; status</h1>
  <div class="sub" id="sub"></div>

  <div class="grid g4" id="head"></div>

  <div class="card" style="margin-top:14px">
    <h2>What is being tested</h2>
    <div class="text" style="font-size:13px;line-height:1.6">
      The backtester fills at the <b>traded print</b>. Its entries cluster at low prices
      (median 0.26, about a quarter at or below 0.05) where depth is least certain, and
      order-book history does not exist &mdash; so that assumption has to be observed forward.
      This page tracks the recordings that will answer it.
    </div>
    <div class="note">
      Two questions, answered in order: <b>(1) fillability</b> &mdash; was the tape's price
      actually available in the live book, and in what size? <b>(2) profitability</b> &mdash;
      does the edge survive contact with the book. Fillability resolves first and is
      answered from any matched entries.
    </div>
  </div>

  <div class="card" style="margin-top:14px">
    <h2>Per asset</h2>
    <table><thead><tr>
      <th>Asset</th><th>Obs</th><th>Span</th><th>Rounds</th><th>Ask p50</th>
      <th>Depth p50</th><th>Expected entries</th><th>At &le;0.05</th><th>Days to 25 cheap</th>
    </tr></thead><tbody id="tbody"></tbody></table>
    <div class="note" id="tablenote"></div>
  </div>

  <div class="grid g2" style="margin-top:14px" id="latest"></div>

  <div class="card" style="margin-top:14px">
    <h2>Timeline to a conclusion</h2>
    <table><thead><tr><th>When</th><th style="text-align:left">What can be concluded</th></tr></thead>
    <tbody>
      <tr><td>24&ndash;48 h</td><td style="text-align:left">Fillability, once ~20&ndash;30 entries have matched books. SOL and ETH carry this.</td></tr>
      <tr><td>2&ndash;4 days</td><td style="text-align:left">Depth at the &le;0.05 entries &mdash; decides whether the low-price edge survives the book.</td></tr>
      <tr><td>~11 days</td><td style="text-align:left">SOL reaches ~200 resolved entries: the headline number to the backtest's own precision.</td></tr>
      <tr><td>~5 months</td><td style="text-align:left">Equivalent sample on BTC alone. BTC is a cross-check, not the sample.</td></tr>
    </tbody></table>
    <div class="note">The binding constraint is the &le;0.05 entries, not the total count: they carry most of the edge and are where depth is least certain.</div>
  </div>

  <div class="card" style="margin-top:14px">
    <h2>Commands</h2>
    <div class="kv"><span>refresh this page</span><code>node scripts/observe-status-page.mjs</code></div>
    <div class="kv"><span>console summary</span><code>node scripts/observe-status.mjs</code></div>
    <div class="kv"><span>integrity check</span><code>node scripts/check-orderbook-data.mjs</code></div>
    <div class="kv"><span>run the join</span><code>node scripts/observe-loop.mjs</code></div>
    <div class="kv"><span>recorder status / stop</span><code>pwsh -File scripts/start-observer.ps1 -Status</code></div>
  </div>
</div>

<script>
const D = ${JSON.stringify(payload)};

const fmt = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x)) ? '&mdash;' : Number(x).toFixed(d);
const num = (x) => (x === null || x === undefined) ? '&mdash;' : Number(x).toLocaleString();

document.getElementById('sub').innerHTML =
  'generated ' + new Date(D.generatedAt).toISOString().replace('T',' ').slice(0,19) + ' UTC'
  + ' &middot; duration ' + D.duration
  + ' &middot; ' + D.bookFiles + ' observation file(s)';

const livePill = D.live
  ? '<span class="pill ok"><i class="dot"></i>recorder live</span>'
  : (D.idleSec === null
      ? '<span class="pill bad"><i class="dot"></i>no data</span>'
      : '<span class="pill warn"><i class="dot"></i>idle ' + Math.round(D.idleSec) + 's</span>');

document.getElementById('head').innerHTML = \`
  <div class="card"><h2>Recorder</h2><div class="big">\${livePill}</div>
    <div class="note">file mtime lag \${D.idleSec === null ? 'n/a' : Math.round(D.idleSec) + 's'}</div></div>
  <div class="card"><h2>Records</h2><div class="big">\${num(D.totalRecords)}</div>
    <div class="note">\${num(D.distinctTs)} timestamps &middot; \${D.spanMin.toFixed(1)} min recorded</div></div>
  <div class="card"><h2>Integrity</h2>
    <div class="big" style="color:\${D.duplicates === 0 ? 'var(--ok)' : 'var(--bad)'}">
      \${D.duplicates === 0 ? 'CLEAN' : D.duplicates + ' DUPES'}</div>
    <div class="note">duplicate (slug,asset,side,ts) keys</div></div>
  <div class="card"><h2>Poll cycle</h2><div class="big">\${D.perTsCounts.length ? D.perTsCounts[0][0] : 0}</div>
    <div class="note">records per timestamp (expect 6 = 3 assets &times; 2 sides)</div></div>
\`;

const tb = document.getElementById('tbody');
for (const a of D.assets) {
  const v = D.byAsset[a];
  if (!v || v.observations === 0) {
    tb.innerHTML += \`<tr><td>\${a.toUpperCase()}</td><td colspan="8" class="muted" style="text-align:left">no observations yet</td></tr>\`;
    continue;
  }
  const bar = Math.min(100, (v.expectedLow / 25) * 100);
  tb.innerHTML += \`<tr>
    <td>\${a.toUpperCase()}</td>
    <td>\${num(v.observations)}</td>
    <td>\${(v.distinctTimestamps * 5 / 60).toFixed(0)}m</td>
    <td>\${v.roundsCovered}</td>
    <td>\${fmt(v.bestAsk.p50, 3)}</td>
    <td>\${num(v.askDepthMedian)} sh</td>
    <td>\${v.expectedAll.toFixed(2)}
      <div class="bar"><i style="width:\${bar}%"></i></div></td>
    <td>\${v.expectedLow.toFixed(2)}</td>
    <td>\${v.daysTo25 === null ? '&mdash;' : v.daysTo25.toFixed(0)}</td>
  </tr>\`;
}

document.getElementById('tablenote').innerHTML =
  'Expected entries are extrapolated from the measured momentum rates (BTC 1.35/day, ETH 9.4/day, SOL 18.3/day) '
  + 'over the recorded span of ' + D.spanHours.toFixed(2) + ' h. Rounds = distinct rounds observed; '
  + 'tape rounds inside that span: '
  + D.assets.map(a => a.toUpperCase() + ' ' + D.byAsset[a].tapeRounds + ' (' + D.byAsset[a].resolvedRounds + ' resolved)').join(', ') + '.';

const lat = document.getElementById('latest');
for (const a of D.assets) {
  const v = D.byAsset[a];
  let rows = '';
  for (const side of ['up','down']) {
    const b = v.latest[side];
    if (!b) continue;
    rows += \`<tr><td>\${side.toUpperCase()}</td>
      <td>\${fmt(b.bestBid,3)} / \${fmt(b.bestAsk,3)}</td>
      <td>\${num(b.askDepth)}</td>
      <td>\${num(b.askDepthAt005)}</td>
      <td>\${num(b.askDepthAt026)}</td></tr>\`;
  }
  lat.innerHTML += \`<div class="card"><h2>\${a.toUpperCase()} &mdash; latest book</h2>
    <table><thead><tr><th>Side</th><th>bid / ask</th><th>asks</th><th>@&le;0.05</th><th>@&le;0.26</th></tr></thead>
    <tbody>\${rows}</tbody></table>
    <div class="note">best-ask p10/p50/p90: \${fmt(v.bestAsk.p10,3)} / \${fmt(v.bestAsk.p50,3)} / \${fmt(v.bestAsk.p90,3)}
    &middot; book age p50 \${num(v.bookAgeMs.p50)}ms</div></div>\`;
}
</script>
</body>
</html>
`;

// Make sure the directory exists before writing.
if (!existsSync(bookDir)) {
  console.error(`no such directory: ${bookDir}`);
  process.exit(1);
}
writeFileSync(outPath, html);

console.log(`\nstatus page written: ${outPath}`);
console.log(`  records: ${totalRecords.toLocaleString()}   integrity: ${duplicates === 0 ? 'CLEAN' : duplicates + ' DUPES'}`);
console.log(`  recorder: ${live ? 'live' : idleSec === null ? 'no data' : `idle ${Math.round(idleSec)}s`}`);
console.log(`\nopen it:  start "" "${outPath}"\n`);

# Overnight session report — observation mode + crypto-hft backtester

Prepared by the agent. Scope agreed with the operator: **options 1 and 2** — (1) get the
system running with dry-run sampling, (2) build a real backtester for the strategy that
actually trades. Autonomous real-money paths were left shut, by agreement.

---

## 1. What now exists

| Artifact | Purpose |
|---|---|
| `src/strategies/crypto-hft/backtest.ts` | Round-driven backtester + Polymarket history fetcher |
| `scripts/crypto-hft-backtest.ts` | Runner — real data, no credentials needed |
| `scripts/check-model-wiring.ts` | Proves the configured model reaches the API call |
| `scripts/check-observation-config.ts` | Asserts every autonomous money path is shut |
| `clodds.observation.json` | Observation-only config: samples, never executes |
| `src/utils/config.ts` | **Fix:** `CLODDS_MODEL` / `ANTHROPIC_MODEL` now actually override the model |
| `src/strategies/crypto-hft/types.ts` | **Fix:** taker fee formula (was understated 2.25×) |
| `.env` | **Added:** `DRY_RUN=true` (backup at `.env.bak-before-dryrun`) |

---

## 2. Three bugs found, and their impact

### 2.1 The taker fee formula was wrong — and it inflated profitability

The repo had `fee_per_share = 0.125 × (p(1−p))²`. Polymarket's documented formula is
`fee = C × feeRate × p × (1−p)`, with `feeRate = 0.07` for crypto markets
(the live market reports `feeType: "crypto_fees_v2"`, `feeSchedule.rate: 0.07`).

At `p = 0.50` the old code returned **0.0078/share against a correct 0.0175/share — a 2.25×
understatement.** The error is not uniform: it vanishes at `p ≈ 0.05/0.95` and is worst at
`p = 0.50`, which is exactly where these Up/Down markets spend most of their life.

Because the error is one-directional, every taker strategy's P&L was biased **upward**.
This is a pure correctness fix; `takerFee()` gained an optional `feeRate` parameter, so
existing single-argument call sites are unaffected (2 live call sites, both verified).

### 2.2 The model config had two independent silent failures

`.env` correctly pointed at a DeepSeek backend. The endpoint worked — the Anthropic SDK
v0.78 reads `ANTHROPIC_BASE_URL` itself (`client.js:49`), so no `baseURL` argument is needed.

But the *model* never came from the environment. `agents/index.ts:17366-17376` resolves:

```
session.context.modelOverride || selectAdaptiveModel(config.agents.defaults.model.primary)
```

`ANTHROPIC_MODEL` was referenced only by the tokenizer and a `/model` display string.
`selectAdaptiveModel`'s `MODEL_META` table (`src/models/adaptive.ts:21`) contains **only
Claude model names**, and returns the configured primary unchanged when it finds no
metadata. So the request shipped `claude-opus-4-6` — a Claude model name — to
`api.deepseek.com/anthropic`.

`scripts/check-model-wiring.ts` demonstrates both states:

```
BEFORE                              AFTER (with the config.ts fix)
resolved : claude-opus-4-6          resolved : deepseek-v4-pro[1m]
client   : api.deepseek.com/...     client   : api.deepseek.com/anthropic
result   : (model not found)        result   : WIRED_OK
```

### 2.3 The conversational order path was **live**, not dry

Every dry-run switch in this codebase is independent, and one of them is an env var:
`credentials/index.ts:334` sets `tradingContext.dryRun = (process.env.DRY_RUN === 'true')`.

`DRY_RUN` was **unset**, so the agent's Polymarket / Kalshi / Opinion / Predict.fun order
tools were treating requests as live orders. Nothing bad happened because there are no
trading credentials, but the safety net was absent, not engaged.

Now `DRY_RUN=true` in `.env`, and `scripts/check-observation-config.ts` fails loudly if it
is ever missing again. (Note: `tradingContext.dryRun` is still computed but never read
anywhere in `agents/index.ts` — the flag that matters is the env var the individual order
handlers read directly.)

---

## 3. The backtester — and what it found

### Why a new one was needed

`src/trading/backtest.ts` cannot test crypto-hft. Its `resolveStrategy()`
(`gateway/api-routes.ts:403-426`) hardcodes exactly three branches — `mean-reversion`,
`momentum`, `buy-and-hold`. The strategy whose P&L actually matters is unreachable.

The live strategy code is also not replayable: every `evaluate*` function and the
`PriceBuffer` window helpers read `Date.now()` internally (`strategies.ts:44,54`;
`positions.ts:225,331,385`). `backtest.ts` therefore reimplements the two
data-computable predicates as pure functions over an explicit `now`.

### Why not all four strategies could be tested

| Strategy | Tier | Reason |
|---|---|---|
| `expiry_fade` | approximate | spread gate omitted (no historical spread) |
| `mean_reversion` | approximate | OBI gate omitted (`book.obi >= -0.1`) |
| `penny_clipper` | **not testable** | returns `null` without a full orderbook; none exists historically |
| `momentum` | **not testable** | needs 5s/30s spot windows; data is 1-minute fidelity |

These are reported as `not_testable`, not silently faked. The backtester prints its own
caveats with every result.

### Data source (no credentials, no infrastructure)

- Round enumeration must be done by **slug**, walking back from the current slot.
  `/events?series_slug=…&closed=true` returns the *oldest* rounds of the series and ignores
  `ascending`, yielding months-old rounds whose CLOB history has aged out.
- Intra-round series: `clob.polymarket.com/prices-history?fidelity=1&interval=1d`
  is the only working combination — it gives **15 points per 15-minute round**.
  `interval=max` silently degrades to 2 points.

---

## 3b. Upgrade: tick-level data (added later the same night)

The minute-bar path above caps out at 24 hours and 15 points per round. A better source
exists and changes the conclusions.

### Where more data comes from

| Limit | Before | After |
|---|---|---|
| Lookback | 24 h (`prices-history` is hard-capped) | **≥120 days** |
| Points/round | 15 (1-minute bars) | **~960 (individual trade prints)** |
| Assets | BTC only tested | 6 (BTC/ETH/SOL/XRP/ZEC/DOGE) |
| Spot feed | none | **Binance 1s klines, free, ≥30 days** |

`data-api.polymarket.com/trades` returns individual fills with
`timestamp / price / size / side / outcomeIndex / transactionHash` and has **no 24-hour
cap** — verified present at 120 days back. For one BTC 15m round that is ~960 prints
covering ~885 of 900 seconds (one print every ~1.5s), versus 15 from `prices-history`.

New tooling: `scripts/crypto-hft-backfill.ts` (resumable JSONL tape cache),
`scripts/crypto-hft-backtest-ticks.ts` (replay), and a `momentum` port in
`backtest.ts` that was previously `not_testable`.

### Result — BTC 15m, 672 rounds, 7.0 days, 645,423 prints, $20.9M round volume

```
                        trades  winRate   gross      fees      NET        fees-off
momentum                    24    75.0%   +$13.45    $6.19    +$7.26      +$13.45
mean_reversion             670    44.8%   +$22.96    $0.00    +$22.96     +$22.96
expiry_fade                667    34.3%   −$42.09  $122.87   −$164.95     −$42.09
```

**Verdict: two of three strategies clear their costs; one does not, and fees are the reason.**

- `expiry_fade` is the only clear loser, and it loses **before** fees (−$42) and far worse
  after (−$165). Fees consume **291.9%** of gross P&L. With 667 trades it is by far the
  most active strategy — activity is exactly what the taker fee punishes. 437 of its 667
  exits are stop-losses.
- `mean_reversion` is the only strategy in the black with a defensible sample: 670 trades,
  +$22.96 net (+1.24% on notional), **$0.034 per trade**. Its `orderMode` is `maker`, so it
  pays no fee. But a maker fill is an assumption, not an observation — see caveats.
- `momentum` wins 75% of 24 trades and is profitable after fees, but **24 trades over 7 days
  is not a sample**. It fires rarely because it needs a 0.15% spot move in 30s plus a ≥2c
  lag, and the staleness gate (`polyAgeSec ≤ 5`) rejects most candidates at 1.5s print
  spacing. Treat this as a hypothesis, not a result.

### Caveats that still apply

- **Fill price = the traded print.** No orderbook depth exists historically, so size impact
  and queue position are unmodelled. `mean_reversion`'s zero fee bill depends on maker fills
  that this data cannot confirm.
- **`momentum`'s spot is a proxy.** Binance 1s spot is not the Chainlink TWAP these markets
  settle on.
- **`penny_clipper` remains untestable.** It needs quotes (`spread ≤ 0.02`), and a traded
  print is not a quote. Unlocking it requires recording the live orderbook going forward —
  i.e. `tickRecorder` plus a TimescaleDB instance.
- The spread gates on `momentum` and `expiry_fade` are likewise omitted.

### Engine correctness note

Replaying 645k prints exposed two performance bugs and one correctness trap in the pure
buffer, all fixed and documented in `backtest.ts`:

1. `unshift()` per tick (O(n) memmove) → append-only ascending layout.
2. Rebuilding a 605k-entry spot `Map` **per round** — the dominant cost; now a cursor.
3. The live 2000-entry cap is a retention **floor**, not a ceiling. Applying it as a ceiling
   silently shrank every window. `scripts/verify-buffer-equiv.ts` pins the optimised buffer
   against a reference implementation over 40,000 values and reports IDENTICAL.

---

## 3c. Sample expansion and cross-validation

Three follow-ups: grow the `momentum` sample, cross-check on other assets, and test whether
`expiry_fade` is mistuned or simply edgeless.

Data now collected (all tick-level via `data-api.polymarket.com/trades`):

| Asset | Rounds | Prints | Avg/round | Window | Round volume |
|---|---|---|---|---|---|
| BTC 15m | 5,677 | 5,662,584 | 997 | 60 days | — |
| ETH 15m | 1,292 | 387,111 | 300 | 14 days | — |
| SOL 15m | 1,289 | 133,975 | 104 | 14 days | — |

### Cross-asset result

| Asset | Strategy | Trades | Win% | Net $ | $/trade | Fees |
|---|---|---|---|---|---|---|
| BTC 60d | **momentum** | 26 | 76.9% | **+13.16** | **+0.506** | 6.77 |
| ETH 14d | **momentum** | 131 | 72.5% | **+19.71** | **+0.150** | 31.16 |
| SOL 14d | **momentum** | 256 | 74.6% | **+156.22** | **+0.610** | 64.02 |
| BTC 60d | expiry_fade | 5,641 | 33.0% | −1,489.53 | −0.264 | 978.56 |
| ETH 14d | expiry_fade | 1,266 | 35.0% | −256.37 | −0.203 | 208.01 |
| SOL 14d | expiry_fade | 1,235 | 29.8% | −600.01 | −0.486 | 208.17 |
| BTC 60d | mean_reversion | 5,653 | 39.0% | −373.36 | −0.066 | 0 |
| ETH 14d | mean_reversion | 1,287 | 39.1% | −66.21 | −0.051 | 0 |
| SOL 14d | mean_reversion | 1,286 | 36.9% | −251.58 | −0.196 | 0 |

**`momentum` is the only strategy profitable on every asset, with a 72–77% win rate.**
The consistency of the win rate across three assets and two sample sizes (26 and 256 trades)
is the strongest signal found so far — it is not a single-sample artefact.

**`expiry_fade` loses on all three, and loses before fees on all three.** It is not an
asset-specific problem.

**`mean_reversion` is the instructive failure.** On the 7-day BTC sample it showed +$0.034
per trade and looked viable. Over 60 days it is −$0.066 per trade. The 7-day result was
noise, and only the larger sample revealed it.

### Threshold sweep: mistuned or edgeless?

`scripts/crypto-hft-sweep.ts` re-runs each strategy across entry thresholds.

**`expiry_fade` — edgeless, not mistuned.** On 5,677 BTC rounds, 13 settings were tested;
the best *per-trade* result of any setting is −$0.223 (skew 0.30 + minSecLeft 240), against
a baseline of −$0.264. Tightening reduces the trade count rather than improving the average.
The same verdict holds on ETH (−0.217 best vs −0.221 baseline) and SOL (−0.458 vs −0.499).
**No threshold makes it positive. It should be disabled, not retuned.**

**`momentum` — the discovery is that its gate is too tight.**
Relaxing `minSpotMovePct` from 0.15 to **0.10** raises the sample from 26 to **82 trades**
while the win rate *rises* to **84.1%**, keeping +$0.367/trade. That is a 3× larger sample
on the same 60 days, still profitable after fees. The live default is therefore discarding
most of the edge.

Also worth noting: `maxPolyStaleSec` (2/10/20) changes nothing — prints are dense enough
that the staleness gate never binds.

**`mean_reversion` — no setting works.** All 10 variants are negative; the least-bad
(`expensiveThreshold` 0.85) is −$0.028/trade.

---

## 3d. What "win rate" actually measured — and a correction

The cross-asset table above reports momentum winning 72–77% of trades. **That number
does not mean what it appears to mean.** Chasing this down took the longest and produced
the most important correction in this report.

### The contradiction that exposed it

A path probe (`scripts/probe-momentum-edge.ts`) recorded, for the same 256 SOL entries
the backtest makes, what the traded side did afterwards:

```
backtest win rate           74.6%
probe win rate AT SETTLEMENT 34.8%   (89/256)
```

Identical entries (256 = 256, matched on entry timestamp, entry-price deciles equal). So
one of the two numbers had to be wrong about what it was measuring.

### The explanation

The instrument pays $1 or $0 at expiry. But the live exit rules take profit at **+15% of
the entry price** and stop out at **−12%** (`positions.ts`). With a median entry near
$0.26, +15% is **four cents**. So the strategy almost never holds to the payout.

An early check of 12 matched trades showed **7 disagreeing on win/loss**: exits that were
tagged `take_profit` (a win) frequently resolved *against* the position, and vice versa.

**"Win rate" in the backtest measures whether the price wiggled up 15% before down 12%.
It is not directional accuracy.** It is a volatility statistic.

### The correction, and what really matters

Because the payoff is asymmetric, settlement win rate is the wrong yardstick anyway. A
contract bought at 0.26 that wins 31% of the time is profitable — (0.31 × 0.74) −
(0.69 × 0.26) > 0. Comparing a 34.8% settlement rate against a 48.3% control rate is
meaningless, because the control cohort sits at a median price of 0.49 and the flagged
cohort at 0.26. Different prices, different payoffs.

The correct question is what the same entries earn. Same 256 entries, same sizing:

| Asset | Entries | Median entry | Settlement win% | Live exit rules | **Hold to settlement** |
|---|---|---|---|---|---|
| BTC | 81 | 0.260 | 30.9% | +$19.06 | **+$33.48** |
| ETH | 131 | 0.240 | 30.5% | +$19.71 | **+$60.40** |
| SOL | 256 | 0.260 | 34.8% | +$156.22 | **+$201.61** |

Two findings:

1. **The entries are longshots bought below their true probability.** Median entry 0.26–0.26
   against a settlement win rate of 30.5–34.8%. That is a genuine mispricing — the market
   underprices these contracts by roughly 5–9 percentage points.
2. **The live exit rules are leaving money on the table on every asset.** Holding to
   settlement earns 1.3–3.1× more than the take-profit/stop-loss rules. A +15% target is
   premature for an instrument whose range is $0.00–$1.00.

### Were the entry prices fillable?

Settlement win rates come from the tape's `resolvedUp` field, so they are independent of
the Binance spot proxy. The entry *price* is not. A cluster at the 5th percentile (0.030 on
BTC) would suggest entries filling at prices that never existed. `scripts/diag-entry-fills.ts`
checks this:

```
entry price p05=0.030 p25=0.110 p50=0.260 p75=0.380 p95=0.470
exact-price repeats <= 2 in round : 24/81
last print older than 10s at entry:  2/81
```

**Only 2 of 81 entries have a stale last print**, and 30% show several prints at the same
price. The entry prices were genuinely available in the tape — the mispricing is not a
stale-print artefact. What this still cannot confirm is **depth**: 20 of 81 BTC entries sit
at or below 0.05, where $20 notional needs 1,795 shares. Orderbook depth is unavailable
historically, so whether those sizes would fill remains unverified.

---

## 3e. Chainlink TWAP vs Binance spot

The settlement reference is Chainlink's BTC/USD 60s TWAP (`resolutionSource`), and the
markets state explicitly that resolution is *"not according to any other sources or spot
markets"*. The backtest feeds `momentum` Binance 1s spot instead.

Chainlink's Data Streams endpoint requires credentials and rate-limits unauthenticated
requests (429), so the stream could not be read directly. Two independent checks were used
instead:

- **Binance data integrity**: 1,000 consecutive seconds with **zero timestamp gaps**.
- **Cross-venue spread**: at one sampled second, Binance closed at 77,123.25 and Bybit at
  77,135.50 — a 12.25-point (0.016%) difference. So "the spot price" is not a single number,
  and Chainlink's aggregate sits inside that spread.
- **Outcome agreement**: the 30.9–34.8% settlement win rate is measured against the tape's
  own resolution field, so it does not depend on the proxy at all. The proxy affects only
  *which* instants fire the signal, not whether the trades won.

**Conclusion: the proxy could not be validated directly, but it is not load-bearing for the
headline result.** The mispricing finding survives without it; only the precise entry
timing depends on Binance matching the oracle's view of the 30s move.




### Result — BTC 15m, 24 rounds / 5.8 hours / $1.2M round volume

```
expiry_fade     21 trades   47.6% win     gross +$2.36   fees $3.13   NET −$0.77  (−2.64%)
mean_reversion  23 trades   26.1% win     gross −$5.20   fees $0.00   NET −$5.20  (−9.18%)
```

**Fees consumed 132.7% of `expiry_fade`'s gross P&L.** The strategy is marginally
profitable before costs and unprofitable after. `mean_reversion` lost money before fees
too, with 17 of 23 exits being stop-losses.

### What this does and does not establish

**Established:** with the corrected fee model, a taker strategy on 15-minute crypto binaries
does not clear its own costs on this sample; and the fee-model error was large enough to
have reversed the sign of the conclusion.

**Not established:** 24 rounds is far too few for statistical significance, and the
approximations (no spread gate, mid-price-drift spot proxy) could move the result either
way. This is a *direction*, not a verdict. The honest next step is more rounds, and
sub-minute spot data to unlock `momentum`.

---

## 4. Current state of the machine

- Port 18789 is free. The pre-existing 20-day gateway (PID 45100, `dist/index.js`) was
  stopped with the operator's agreement — **restart it yourself when you want it back.**
- Source builds clean: `npx tsc --noEmit` exits 0.
- Gateway verified to boot to `Clodds is running!` on the DeepSeek backend.
- Non-blocking noise in the logs: `transformers.js` embedding model fails to load (falls back
  to simple embeddings), Manifold WebSocket retries, PredictIt fetch error, and a
  "Missing Solana wallet credentials" warning. All harmless in observation mode.

## 5. Reproduce

```bash
npx tsx scripts/check-observation-config.ts          # safety assertions
npx tsx scripts/check-model-wiring.ts                # model + backend
npx tsx scripts/crypto-hft-backtest.ts --asset btc --duration 15m --rounds 24
CLODDS_CONFIG_PATH=clodds.observation.json npx tsx src/index.ts   # observation mode
```

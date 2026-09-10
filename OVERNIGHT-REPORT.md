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

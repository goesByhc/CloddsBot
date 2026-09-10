/**
 * Smoke-test the observation config: does it parse, and are all autonomous money
 * paths actually pinned shut?
 *
 *   npx tsx scripts/check-observation-config.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { join, resolve } from 'path';
import { homedir } from 'os';

dotenvConfig({ path: join(homedir(), '.clodds', '.env') });
dotenvConfig();

async function main() {
  process.env.CLODDS_CONFIG_PATH = resolve('clodds.observation.json');
  const { loadConfig } = await import('../src/utils/config');
  const cfg = await loadConfig(resolve('clodds.observation.json'));

  type Check = { label: string; ok: boolean; detail: string };
  const checks: Check[] = [];

  const sr = (cfg as any).signalRouter ?? {};
  const tr = (cfg as any).trading ?? {};

  checks.push({
    label: 'signalRouter.enabled (need true — this is the sampler)',
    ok: sr.enabled === true,
    detail: String(sr.enabled),
  });
  checks.push({
    label: 'signalRouter.dryRun (MUST be true)',
    ok: sr.dryRun === true,
    detail: String(sr.dryRun),
  });
  checks.push({
    label: 'trading.dryRun (MUST be true)',
    ok: tr.dryRun === true,
    detail: String(tr.dryRun),
  });
  checks.push({
    label: 'trading.enabled (MUST be false)',
    ok: tr.enabled === false,
    detail: String(tr.enabled),
  });
  checks.push({
    label: 'arbitrageExecution.enabled (MUST be false)',
    ok: (cfg as any).arbitrageExecution?.enabled === false,
    detail: String((cfg as any).arbitrageExecution?.enabled),
  });
  checks.push({
    label: 'venueArbitrage.enabled (MUST be false)',
    ok: (cfg as any).venueArbitrage?.enabled === false,
    detail: String((cfg as any).venueArbitrage?.enabled),
  });
  checks.push({
    label: 'copyTrading.enabled (MUST be false)',
    ok: (cfg as any).copyTrading?.enabled === false,
    detail: String((cfg as any).copyTrading?.enabled),
  });
  checks.push({
    label: 'trading.cryptoHft.enabled (MUST be false — not yet validated)',
    ok: tr.cryptoHft?.enabled === false,
    detail: String(tr.cryptoHft?.enabled),
  });
  checks.push({
    label: 'trading.marketMaking.enabled (MUST be false)',
    ok: tr.marketMaking?.enabled === false,
    detail: String(tr.marketMaking?.enabled),
  });

  // Env-dependent switches that this file cannot set.
  checks.push({
    label: 'process.env.DRY_RUN (conversational order path)',
    ok: process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1',
    detail: process.env.DRY_RUN ?? '(unset) — set DRY_RUN=true in .env',
  });

  checks.push({
    label: 'model resolves to the DeepSeek model, not a Claude name',
    ok: !String(cfg.agents?.defaults?.model?.primary ?? '').startsWith('claude-'),
    detail: String(cfg.agents?.defaults?.model?.primary),
  });

  console.log('\nObservation-config safety checks\n' + '-'.repeat(60));
  let allOk = true;
  for (const c of checks) {
    if (!c.ok) allOk = false;
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}\n        -> ${c.detail}`);
  }
  console.log('-'.repeat(60));
  console.log(allOk ? 'ALL CHECKS PASS\n' : 'SOME CHECKS FAILED — do not run live\n');
  if (!allOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

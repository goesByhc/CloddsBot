/**
 * One-shot diagnostic: does the configured model override reach the API call,
 * and does the configured backend actually answer?
 *
 *   npx tsx scripts/check-model-wiring.ts
 *
 * Reproduces the exact resolution path used by agents/index.ts:17366-17376:
 *   sessionOverride || selectAdaptiveModel({ primary, fallbacks, strategy })
 * then issues a real request with `new Anthropic({ apiKey })` — deliberately the
 * same construction as agents/index.ts:17092, so SDK env handling is included.
 */
import { config as dotenvConfig } from 'dotenv';
import { join } from 'path';
import { homedir } from 'os';

dotenvConfig({ path: join(homedir(), '.clodds', '.env') });
dotenvConfig();

async function main() {
  const { loadConfig } = await import('../src/utils/config');
  const { selectAdaptiveModel, getModelStrategy } = await import('../src/models');

  const cfg = await loadConfig();
  const primary = cfg.agents?.defaults?.model?.primary;
  const fallbacks = cfg.agents?.defaults?.model?.fallbacks;

  console.log('env ANTHROPIC_BASE_URL :', process.env.ANTHROPIC_BASE_URL ?? '(unset)');
  console.log('env ANTHROPIC_MODEL    :', process.env.ANTHROPIC_MODEL ?? '(unset)');
  console.log('env CLODDS_MODEL       :', process.env.CLODDS_MODEL ?? '(unset)');
  console.log('config primary         :', primary);
  console.log('config fallbacks       :', JSON.stringify(fallbacks));

  const adaptive = selectAdaptiveModel({ primary: primary as string, fallbacks, strategy: getModelStrategy() });
  console.log('resolved (adaptive)    :', adaptive);

  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('\nANTHROPIC_API_KEY missing — cannot test the call.');
    process.exit(1);
  }
  // Same construction as the agent: no explicit baseURL, rely on SDK env pickup.
  const client = new Anthropic({ apiKey });
  console.log('client.baseURL         :', client.baseURL);

  const wrongModel = adaptive.startsWith('claude-');
  console.log(
    `\n${wrongModel ? 'MISMATCH:' : 'OK:'} resolved model ${wrongModel ? 'IS' : 'is not'} a Claude name while the backend is ${client.baseURL}`
  );

  console.log('\nIssuing a real request with the resolved model...');
  try {
    const r = await client.messages.create({
      model: adaptive,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Reply with exactly: WIRED_OK' }],
    });
    const text = r.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    console.log(`SUCCESS — model=${r.model} stop=${r.stop_reason}`);
    console.log('text:', text.trim());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`FAILED — ${msg}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

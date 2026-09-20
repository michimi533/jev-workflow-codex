import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApiKey, decide } from './jev-decide.mjs';

const defaultEnvFile = fileURLToPath(new URL('../.env.local', import.meta.url));

// Explicit file option also works inside cua_repl, where process.env may be unavailable.
export function getJevOptions({ envFile = defaultEnvFile } = {}) {
  return {
    endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
    model: 'typesafe-ai/jev',
    apiKey: loadApiKey({ envVar: 'AI_GATEWAY_API_KEY', envFile: path.resolve(envFile) }),
    maxRetries: 0,
    timeoutMs: 30000,
  };
}

export async function decideWithGatewayCost(input) {
  const result = await decide(input);
  const rawCost = result.raw?.provider_metadata?.gateway?.cost;
  const cost = rawCost == null ? null : Number(rawCost);
  return { ...result, costUsd: Number.isFinite(cost) ? cost : null };
}

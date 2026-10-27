export const DINING_DEFAULT_PORT = 4001;

export function getDiningPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DINING_PORT?.trim();
  if (!raw) return DINING_DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DINING_PORT must be an integer between 1 and 65535');
  }
  return port;
}

// Protects future dining scrape endpoints. /health stays public.
export function getDiningApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.DINING_API_KEY?.trim();
  return key ? key : undefined;
}

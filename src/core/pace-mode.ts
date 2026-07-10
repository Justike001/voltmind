/** DB-contention pacing mode bundles. Defaults to off. */

export type PaceMode = 'off' | 'gentle' | 'balanced' | 'aggressive';

export const PACE_MODES: ReadonlyArray<PaceMode> = Object.freeze([
  'off',
  'gentle',
  'balanced',
  'aggressive',
]);

export const DEFAULT_PACE_MODE: PaceMode = 'off';

export interface PaceBundle {
  enabled: boolean;
  maxConcurrency: number;
  paceAtMs: number;
  maxSleepMs: number;
  ewmaAlpha: number;
}

export const PACE_BUNDLES: Readonly<Record<PaceMode, Readonly<PaceBundle>>> = Object.freeze({
  off: Object.freeze({
    enabled: false,
    maxConcurrency: 0,
    paceAtMs: 0,
    maxSleepMs: 0,
    ewmaAlpha: 0,
  }),
  gentle: Object.freeze({
    enabled: true,
    maxConcurrency: 4,
    paceAtMs: 250,
    maxSleepMs: 2000,
    ewmaAlpha: 0.3,
  }),
  balanced: Object.freeze({
    enabled: true,
    maxConcurrency: 8,
    paceAtMs: 500,
    maxSleepMs: 1500,
    ewmaAlpha: 0.3,
  }),
  aggressive: Object.freeze({
    enabled: true,
    maxConcurrency: 16,
    paceAtMs: 1000,
    maxSleepMs: 1000,
    ewmaAlpha: 0.3,
  }),
});

export function isPaceMode(value: unknown): value is PaceMode {
  return typeof value === 'string' && (PACE_MODES as ReadonlyArray<string>).includes(value);
}

export interface PaceKeyOverrides {
  enabled?: boolean;
  maxConcurrency?: number;
  paceAtMs?: number;
  maxSleepMs?: number;
  ewmaAlpha?: number;
}

export interface ResolvePaceModeInput {
  mode?: string;
  envMode?: string;
  perCallMode?: string;
  configOverrides?: PaceKeyOverrides;
  envOverrides?: PaceKeyOverrides;
  perCall?: PaceKeyOverrides;
}

export interface ResolvedPaceKnobs extends PaceBundle {
  resolved_mode: PaceMode;
  mode_valid: boolean;
}

export function resolvePaceMode(input: ResolvePaceModeInput): ResolvedPaceKnobs {
  const rawMode =
    firstString(input.perCallMode) ?? firstString(input.envMode) ?? firstString(input.mode);
  const normalized = rawMode ? rawMode.trim().toLowerCase() : '';
  const modeValid = isPaceMode(normalized);
  const resolved_mode: PaceMode = modeValid ? (normalized as PaceMode) : DEFAULT_PACE_MODE;
  const bundle = PACE_BUNDLES[resolved_mode];
  const pc = input.perCall ?? {};
  const env = input.envOverrides ?? {};
  const cfg = input.configOverrides ?? {};

  const pick = <K extends keyof PaceBundle>(key: K): PaceBundle[K] => {
    if (pc[key] !== undefined) return pc[key] as PaceBundle[K];
    if (env[key] !== undefined) return env[key] as PaceBundle[K];
    if (cfg[key] !== undefined) return cfg[key] as PaceBundle[K];
    return bundle[key];
  };

  const enabled = pick('enabled');
  let maxConcurrency = pick('maxConcurrency');
  if (enabled && (!Number.isFinite(maxConcurrency) || maxConcurrency < 1)) {
    maxConcurrency = bundle.enabled ? bundle.maxConcurrency : 8;
  }
  let ewmaAlpha = pick('ewmaAlpha');
  if (!Number.isFinite(ewmaAlpha) || ewmaAlpha <= 0 || ewmaAlpha > 1) {
    ewmaAlpha = bundle.enabled ? bundle.ewmaAlpha : 0.3;
  }

  return {
    enabled,
    maxConcurrency,
    paceAtMs: Math.max(0, pick('paceAtMs')),
    maxSleepMs: Math.max(0, pick('maxSleepMs')),
    ewmaAlpha,
    resolved_mode,
    mode_valid: modeValid,
  };
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export const PACE_MODE_KEY = 'pace.mode';

export const PACE_MODE_CONFIG_KEYS: ReadonlyArray<string> = Object.freeze([
  'pace.enabled',
  'pace.max_concurrency',
  'pace.pace_at_ms',
  'pace.max_sleep_ms',
  'pace.ewma_alpha',
]);

export function loadOverridesFromConfig(
  configMap: Record<string, string | undefined>,
): PaceKeyOverrides {
  return parseOverrides((key) => configMap[key], {
    enabled: 'pace.enabled',
    maxConcurrency: 'pace.max_concurrency',
    paceAtMs: 'pace.pace_at_ms',
    maxSleepMs: 'pace.max_sleep_ms',
    ewmaAlpha: 'pace.ewma_alpha',
  });
}

export function readPaceEnv(env: Record<string, string | undefined> = process.env): {
  envMode?: string;
  envOverrides: PaceKeyOverrides;
} {
  const envOverrides = parseOverrides((key) => env[key], {
    enabled: 'VOLTMIND_PACE_ENABLED',
    maxConcurrency: 'VOLTMIND_PACE_MAX_CONCURRENCY',
    paceAtMs: 'VOLTMIND_PACE_AT_MS',
    maxSleepMs: 'VOLTMIND_PACE_MAX_SLEEP_MS',
    ewmaAlpha: 'VOLTMIND_PACE_EWMA_ALPHA',
  });
  return { envMode: env.VOLTMIND_PACE_MODE, envOverrides };
}

function parseOverrides(
  get: (key: string) => string | undefined,
  keys: Record<keyof PaceKeyOverrides, string>,
): PaceKeyOverrides {
  const out: PaceKeyOverrides = {};
  const enabled = get(keys.enabled);
  if (enabled !== undefined) out.enabled = enabled === '1' || enabled.toLowerCase() === 'true';
  const maxConcurrency = get(keys.maxConcurrency);
  if (maxConcurrency !== undefined) {
    const n = parseInt(maxConcurrency, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 256) out.maxConcurrency = n;
  }
  const paceAt = get(keys.paceAtMs);
  if (paceAt !== undefined) {
    const n = parseInt(paceAt, 10);
    if (Number.isFinite(n) && n >= 0) out.paceAtMs = n;
  }
  const maxSleep = get(keys.maxSleepMs);
  if (maxSleep !== undefined) {
    const n = parseInt(maxSleep, 10);
    if (Number.isFinite(n) && n >= 0) out.maxSleepMs = n;
  }
  const alpha = get(keys.ewmaAlpha);
  if (alpha !== undefined) {
    const n = parseFloat(alpha);
    if (Number.isFinite(n) && n > 0 && n <= 1) out.ewmaAlpha = n;
  }
  return out;
}

export async function loadPaceModeConfig(engine: {
  getConfig(key: string): Promise<string | null>;
}): Promise<{ mode?: string; configOverrides: PaceKeyOverrides }> {
  const safeGet = async (key: string): Promise<string | undefined> => {
    try {
      const value = await engine.getConfig(key);
      return typeof value === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const [mode, ...values] = await Promise.all([
    safeGet(PACE_MODE_KEY),
    ...PACE_MODE_CONFIG_KEYS.map(safeGet),
  ]);
  const configMap: Record<string, string | undefined> = {};
  PACE_MODE_CONFIG_KEYS.forEach((key, index) => {
    if (values[index] !== undefined) configMap[key] = values[index];
  });
  return { mode, configOverrides: loadOverridesFromConfig(configMap) };
}

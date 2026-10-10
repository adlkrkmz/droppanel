import fs from 'node:fs';
import path from 'node:path';
import { AppConfig, WorkerName } from './types';

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'config', 'config.json');

export function loadConfig(): AppConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AppConfig>;
  return {
    localPort: Number(raw.localPort ?? 3300),
    keepaConcurrency: 1,
    amazonMode: raw.amazonMode === 'PARALLEL_3' ? 'PARALLEL_3' : 'FAILOVER',
    amazonWorkers: (raw.amazonWorkers ?? ['A', 'B', 'C']) as WorkerName[],
    amazonActiveConcurrency: 1,
    amazonHeadless: Boolean(raw.amazonHeadless ?? false),
    navigationTimeout: Number(raw.navigationTimeout ?? 30000),
    keepaHeadless: Boolean(raw.keepaHeadless ?? false),
    keepaDelayMs: Number(raw.keepaDelayMs ?? 1500),
    amazonDelayMs: Number(raw.amazonDelayMs ?? 2500),
    technicalRetryMax: Number(raw.technicalRetryMax ?? 1)
  };
}

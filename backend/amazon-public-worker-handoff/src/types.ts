export type WorkerName = 'A' | 'B' | 'C';

export type AppConfig = {
  localPort: number;
  keepaConcurrency: 1;
  amazonMode: 'FAILOVER' | 'PARALLEL_3';
  amazonWorkers: WorkerName[];
  amazonActiveConcurrency: 1;
  amazonHeadless: boolean;
  navigationTimeout: number;
  keepaHeadless: boolean;
  keepaDelayMs: number;
  amazonDelayMs: number;
  technicalRetryMax: number;
};

export type ResearchRow = Record<string, unknown> & { asin: string };

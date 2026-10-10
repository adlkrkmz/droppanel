/**
 * READ-ONLY: public Amazon worker vs 20 real production ASINs.
 * - Does NOT claim queue tasks
 * - Does NOT call Stock Guard / qty0 / price / alert / eBay
 * - Does NOT touch login profile (var/amazon-browser-profile)
 * - Stops on CAPTCHA / challenge
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  AmazonPublicWorker,
  PUBLIC_AMAZON_PROFILE_ROOT,
  setPublicWorkerPersistenceSink,
  type AppConfig
} from '../modules/amazonPublicWorker';

const ROOT = path.resolve(__dirname, '..');
const ASIN_FILE = path.resolve(ROOT, '..', 'amazon-research-500-asins.txt');
const OUT_JSON = path.join(ROOT, 'var', 'diagnostics', 'amazon-public-readonly-20.json');
const OUT_TXT = path.join(ROOT, 'var', 'diagnostics', 'amazon-public-readonly-20.txt');

const LOGIN_PROFILE = path.join(ROOT, 'var', 'amazon-browser-profile');
const SAMPLE_COUNT = 20;
const DELAY_MS = 2500;

type Row = {
  asin: string;
  actualAsin: string | null;
  status: string;
  offer: string | null;
  price: string | null;
  prime: string;
  shipsFrom: string | null;
  soldBy: string | null;
  availability: string | null;
  kind: string;
  note: string;
  criticalOk: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function loadAsins(): string[] {
  const lines = fs.readFileSync(ASIN_FILE, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim().toUpperCase())
    .filter((l) => /^[A-Z0-9]{10}$/.test(l));
  const unique = [...new Set(lines)];
  if (unique.length < SAMPLE_COUNT) throw new Error(`Need ${SAMPLE_COUNT} ASINs, got ${unique.length}`);
  return unique.slice(0, SAMPLE_COUNT);
}

function assertSafeProfiles(): void {
  if (PUBLIC_AMAZON_PROFILE_ROOT.includes('amazon-browser-profile') && !PUBLIC_AMAZON_PROFILE_ROOT.includes('amazon-public')) {
    throw new Error('Refusing to use login profile path');
  }
  if (path.resolve(PUBLIC_AMAZON_PROFILE_ROOT) === path.resolve(LOGIN_PROFILE)) {
    throw new Error('Public profile must not equal login profile');
  }
}

function isCriticalParseError(status: string, kind: string): boolean {
  if (kind === 'technical') return true;
  if (kind === 'challenge') return true;
  // Incomplete = cannot make a production decision from read
  if (status === 'AMAZON_INCOMPLETE') return true;
  return false;
}

function formatPrice(v: number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return `$${v.toFixed(2)}`;
}

async function main(): Promise<void> {
  assertSafeProfiles();
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.mkdirSync(PUBLIC_AMAZON_PROFILE_ROOT, { recursive: true });

  const asins = loadAsins();
  const captured: Array<{ asin: string; patch: Record<string, unknown> }> = [];
  setPublicWorkerPersistenceSink({
    logEvent: (event, asin, worker, detail) => {
      console.log(`[public] ${event} asin=${asin ?? '-'} worker=${worker ?? '-'} ${detail ?? ''}`);
    },
    updateItem: (asin, patch) => {
      captured.push({ asin, patch });
    }
  });

  const config: AppConfig = {
    localPort: 0,
    keepaConcurrency: 1,
    amazonMode: 'FAILOVER',
    amazonWorkers: ['A'],
    amazonActiveConcurrency: 1,
    amazonHeadless: true,
    navigationTimeout: 45000,
    keepaHeadless: true,
    keepaDelayMs: 1500,
    amazonDelayMs: DELAY_MS,
    technicalRetryMax: 1
  };

  const worker = new AmazonPublicWorker('A', config);
  const rows: Row[] = [];
  let captchaCount = 0;
  let technicalErrorCount = 0;
  let criticalParseErrorCount = 0;
  let stoppedEarly = false;
  let stopReason: string | null = null;

  console.log(`PUBLIC_PROFILE_PATH=${PUBLIC_AMAZON_PROFILE_ROOT}`);
  console.log(`ASIN_FILE=${ASIN_FILE}`);
  console.log(`SAMPLE=${asins.join(',')}`);
  console.log('MODE=READ_ONLY (no queue claim, no mutations)');

  try {
    for (let i = 0; i < asins.length; i += 1) {
      const asin = asins[i];
      console.log(`\n=== [${i + 1}/${asins.length}] ${asin} ===`);
      const result = await worker.observe(asin);

      if (result.kind === 'challenge') {
        captchaCount += 1;
        criticalParseErrorCount += 1;
        rows.push({
          asin,
          actualAsin: null,
          status: 'CHALLENGE',
          offer: null,
          price: null,
          prime: 'n/a',
          shipsFrom: null,
          soldBy: null,
          availability: null,
          kind: result.kind,
          note: result.reason ?? 'challenge',
          criticalOk: false
        });
        stoppedEarly = true;
        stopReason = `CAPTCHA/challenge: ${result.reason ?? 'unknown'}`;
        console.error(`STOP: ${stopReason}`);
        break;
      }

      if (result.kind === 'technical') {
        technicalErrorCount += 1;
        criticalParseErrorCount += 1;
        rows.push({
          asin,
          actualAsin: null,
          status: 'TECHNICAL',
          offer: null,
          price: null,
          prime: 'n/a',
          shipsFrom: null,
          soldBy: null,
          availability: null,
          kind: result.kind,
          note: result.reason ?? 'technical',
          criticalOk: false
        });
        // Continue on technical? User said CAPTCHA stop; technical count separately.
        // Treat consecutive technical as continue but mark critical.
        if (i + 1 < asins.length) await sleep(DELAY_MS);
        continue;
      }

      const obs = result.observation!;
      const status = result.status ?? 'UNKNOWN';
      const criticalFail = isCriticalParseError(status, result.kind);
      if (criticalFail) criticalParseErrorCount += 1;

      const noteParts: string[] = [];
      if (status === 'ASIN_MISMATCH_OBSERVED') noteParts.push('ASIN redirect/mismatch');
      if (status === 'PRODUCT_NOT_FOUND_OBSERVED') noteParts.push('Product Not Found');
      if (status === 'OUT_OF_STOCK_OBSERVED') noteParts.push('Out of Stock');
      if (status === 'NEW_OFFER_UNAVAILABLE') noteParts.push(`Resale/Used/unavailable (${obs.offerCondition})`);
      if (status === 'AMAZON_CHECKED') noteParts.push('New offer OK');
      if (status === 'AMAZON_INCOMPLETE') noteParts.push('INCOMPLETE — critical');

      rows.push({
        asin,
        actualAsin: obs.actualAsin,
        status,
        offer: obs.offerCondition,
        price: formatPrice(obs.mainPrice),
        prime: obs.primeVisible === null ? 'null' : obs.primeVisible ? 'yes' : 'no',
        shipsFrom: obs.shipsFrom,
        soldBy: obs.soldBy,
        availability: obs.availability,
        kind: result.kind,
        note: noteParts.join('; ') || '',
        criticalOk: !criticalFail
      });

      if (i + 1 < asins.length) await sleep(DELAY_MS);
    }
  } finally {
    await worker.close('COLD_STANDBY');
    setPublicWorkerPersistenceSink(null);
  }

  const complete = rows.length;
  const criticalOkCount = rows.filter((r) => r.criticalOk).length;
  const ready = !stoppedEarly && complete === SAMPLE_COUNT && criticalOkCount === SAMPLE_COUNT && captchaCount === 0 && technicalErrorCount === 0;

  const tableHeader = 'ASIN | actualAsin | status | offer | price | Prime | Ships From | Sold By | availability';
  const tableLines = rows.map((r) =>
    [
      r.asin,
      r.actualAsin ?? '-',
      r.status,
      r.offer ?? '-',
      r.price ?? '-',
      r.prime,
      (r.shipsFrom ?? '-').replace(/\|/g, '/'),
      (r.soldBy ?? '-').replace(/\|/g, '/'),
      (r.availability ?? '-').replace(/\|/g, '/')
    ].join(' | ')
  );

  const report = [
    '=== AMAZON PUBLIC WORKER READ-ONLY 20 ASIN TEST ===',
    `PUBLIC_PROFILE_PATH: ${PUBLIC_AMAZON_PROFILE_ROOT}`,
    `LOGIN_PROFILE_UNTOUCHED: ${LOGIN_PROFILE}`,
    `TOTAL_REQUESTED: ${SAMPLE_COUNT}`,
    `PUBLIC_WORKER_COMPLETE: ${complete}`,
    `STOPPED_EARLY: ${stoppedEarly}`,
    `STOP_REASON: ${stopReason ?? '-'}`,
    `CAPTCHA_COUNT: ${captchaCount}`,
    `TECHNICAL_ERROR_COUNT: ${technicalErrorCount}`,
    `CRITICAL_PARSE_ERROR_COUNT: ${criticalParseErrorCount}`,
    `CRITICAL_OK_COUNT: ${criticalOkCount}`,
    `PUBLIC_WORKER_READY_FOR_TASK_OWNERSHIP: ${ready ? 'YES' : 'NO'}`,
    `Production mutation: NO`,
    `Task ownership: NO`,
    '',
    tableHeader,
    ...tableLines,
    '',
    'NOTES:',
    ...rows.map((r) => `${r.asin}: ${r.note || r.kind}`)
  ].join('\n');

  fs.writeFileSync(OUT_TXT, report, 'utf8');
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    publicProfilePath: PUBLIC_AMAZON_PROFILE_ROOT,
    asins,
    captchaCount,
    technicalErrorCount,
    criticalParseErrorCount,
    criticalOkCount,
    ready,
    stoppedEarly,
    stopReason,
    rows,
    capturedCount: captured.length
  }, null, 2), 'utf8');

  console.log('\n' + report);
  console.log(`\nWrote ${OUT_TXT}`);
  console.log(`Wrote ${OUT_JSON}`);

  if (!ready) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

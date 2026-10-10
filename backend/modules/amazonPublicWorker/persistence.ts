/**
 * Production sink stubs for public Amazon worker.
 * Lab used SQLite logEvent/updateItem — not carried over.
 * Read-only test / future queue consumers inject a sink; default is no-op.
 * Never mutates Stock Guard / eBay / alerts from this layer.
 */

export type PublicWorkerItemPatch = Record<string, unknown>;

export type PublicWorkerPersistenceSink = {
  logEvent: (event: string, asin: string | null, worker: string | null, detail?: string) => void;
  updateItem: (asin: string, patch: PublicWorkerItemPatch) => void;
};

const noopSink: PublicWorkerPersistenceSink = {
  logEvent: () => undefined,
  updateItem: () => undefined
};

let sink: PublicWorkerPersistenceSink = noopSink;

export function setPublicWorkerPersistenceSink(next: PublicWorkerPersistenceSink | null): void {
  sink = next ?? noopSink;
}

export function logEvent(event: string, asin: string | null, worker: string | null, detail?: string): void {
  sink.logEvent(event, asin, worker, detail);
}

export function updateItem(asin: string, patch: PublicWorkerItemPatch): void {
  sink.updateItem(asin, patch);
}

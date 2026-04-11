import { randomUUID } from 'crypto'

export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

export interface LogEntry {
  timestamp: string
  level: LogLevel
  service: string
  traceId?: string
  jobId?: string
  asin?: string
  storeId?: string
  message: string
  error?: string
}

export function log(entry: Omit<LogEntry, 'timestamp'>): void {
  const logEntry: LogEntry = {
    timestamp: new Date().toISOString(),
    ...entry
  }
  console.log(JSON.stringify(logEntry))
}

export function generateTraceId(): string {
  return randomUUID()
}

export function createLogger(service: string, traceId?: string) {
  return {
    info: (message: string, meta?: Partial<LogEntry>) =>
      log({ level: 'info', service, traceId, message, ...meta }),
    warn: (message: string, meta?: Partial<LogEntry>) =>
      log({ level: 'warn', service, traceId, message, ...meta }),
    error: (message: string, meta?: Partial<LogEntry>) =>
      log({ level: 'error', service, traceId, message, ...meta }),
    debug: (message: string, meta?: Partial<LogEntry>) =>
      log({ level: 'debug', service, traceId, message, ...meta }),
  }
}

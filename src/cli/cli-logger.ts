import { LoggerService, LogLevel } from '@nestjs/common';

/** Every level, enabled when the CLI runs with `--verbose`. */
const ALL_LEVELS: LogLevel[] = [
  'log',
  'error',
  'warn',
  'debug',
  'verbose',
  'fatal',
];

/** Quiet default: only problems, and nothing on stdout. */
const QUIET_LEVELS: LogLevel[] = ['warn', 'error', 'fatal'];

/**
 * A NestJS {@link LoggerService} for the CLI that writes ALL diagnostics to
 * **stderr**, so the command's data output on **stdout** (e.g. `--json`) is never
 * polluted by log lines. NestJS's default `ConsoleLogger` sends `log`/`debug`/
 * `verbose` to stdout, which is exactly what mixes log noise into the JSON.
 *
 * Quiet by default (warnings/errors only); `verbose` enables the full set.
 * Installed in `main.ts` via `Logger.overrideLogger(...)` before any service
 * (and therefore any `logger.debug(...)`) runs.
 */
export class StderrCliLogger implements LoggerService {
  private readonly enabled: Set<LogLevel>;

  constructor(verbose: boolean) {
    this.enabled = new Set<LogLevel>(verbose ? ALL_LEVELS : QUIET_LEVELS);
  }

  private emit(level: LogLevel, message: unknown, context?: unknown): void {
    if (!this.enabled.has(level)) {
      return;
    }
    const ctx = typeof context === 'string' && context ? ` [${context}]` : '';
    process.stderr.write(`[${level.toUpperCase()}]${ctx} ${String(message)}\n`);
  }

  log(message: unknown, context?: unknown): void {
    this.emit('log', message, context);
  }

  error(message: unknown, context?: unknown): void {
    this.emit('error', message, context);
  }

  warn(message: unknown, context?: unknown): void {
    this.emit('warn', message, context);
  }

  debug(message: unknown, context?: unknown): void {
    this.emit('debug', message, context);
  }

  verbose(message: unknown, context?: unknown): void {
    this.emit('verbose', message, context);
  }

  fatal(message: unknown, context?: unknown): void {
    this.emit('fatal', message, context);
  }
}

// SPDX-License-Identifier: Apache-2.0

/** How serious a log entry is. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * One structured log entry. Every entry the gateway writes carries the request id; none ever
 * carries a credential, a header value or an upstream URL's query string.
 */
export interface LogEntry {
  readonly level: LogLevel;
  /** What happened, e.g. "request", "upstream failed", "audit hook failed". */
  readonly message: string;
  readonly requestId: string;
  /** Further facts: repository, endpoint, principal subject, status, duration, reason. */
  readonly [field: string]: string | number | boolean | null | readonly string[] | undefined;
}

/** Where the gateway writes its structured logs. */
export interface Logger {
  log(entry: LogEntry): void;
}

/** A logger that drops everything. */
export const silentLogger: Logger = { log: () => undefined };

/**
 * A logger that writes each entry as one JSON line to the console, which Workers Logs and
 * `wrangler tail` collect.
 */
export const consoleLogger: Logger = {
  log(entry) {
    const line = JSON.stringify(entry);
    // The console is the Workers runtime's log sink; this is the gateway's only use of it.
    // oxlint-disable-next-line no-console
    if (entry.level === 'error') console.error(line);
    // oxlint-disable-next-line no-console
    else console.log(line);
  },
};

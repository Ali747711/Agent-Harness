/**
 * Typed error taxonomy (PHASE1-PLAN.md step 2). Codes grow as modules land;
 * every user-facing failure must map to a code so clients can render a
 * distinct message and suggested next action (R10).
 */
export type HarnessErrorCode =
  | 'config_invalid'
  | 'config_unreadable'
  | 'protocol_invalid'
  | 'model_request_failed'
  | 'session_not_found'
  | 'session_corrupt'
  | 'session_write_failed'
  | 'permission_denied'
  | 'aborted'
  | 'internal';

export interface HarnessErrorOptions {
  recoverable?: boolean;
  details?: unknown;
  cause?: unknown;
}

export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  readonly recoverable: boolean;
  readonly details: unknown;

  constructor(code: HarnessErrorCode, message: string, options: HarnessErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HarnessError';
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.details = options.details;
  }
}

export function isHarnessError(value: unknown): value is HarnessError {
  return value instanceof HarnessError;
}

import type { ErrorCode } from '@screenfin/protocol';

/**
 * Domain-level failure thrown by the room manager / auth flow; the router maps
 * it to a protocol `error` message.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    retryable: boolean = code === 'RATE_LIMITED' ||
      code === 'INTERNAL' ||
      code === 'VISIBILITY_PENDING',
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.retryable = retryable;
  }
}

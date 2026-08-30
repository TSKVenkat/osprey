export type StorageErrorCode =
  | 'INVALID_KEY'
  | 'NOT_FOUND'
  | 'PART_TOO_SMALL'
  | 'PARTS_NOT_DENSE'
  | 'UNSUPPORTED'
  | 'PROVIDER_ERROR';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  /** Whether the caller's retry loop should bother. */
  readonly retryable: boolean;

  constructor(code: StorageErrorCode, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

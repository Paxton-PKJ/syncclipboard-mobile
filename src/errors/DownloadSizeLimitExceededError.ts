export const DOWNLOAD_SIZE_LIMIT_EXCEEDED_NAME = 'DownloadSizeLimitExceededError';
export const DOWNLOAD_SIZE_LIMIT_EXCEEDED_CODE = 'ERR_DOWNLOAD_SIZE_LIMIT_EXCEEDED';

/**
 * 流式下载超出字节上限时抛出的错误。
 * 消息刻意不包含 abort/cancel 字样，避免被取消分支吞并。
 */
export class DownloadSizeLimitExceededError extends Error {
  public readonly code = DOWNLOAD_SIZE_LIMIT_EXCEEDED_CODE;

  constructor(message = 'Download size exceeds limit') {
    super(message);
    this.name = DOWNLOAD_SIZE_LIMIT_EXCEEDED_NAME;
    Object.setPrototypeOf(this, DownloadSizeLimitExceededError.prototype);
  }
}

export function isDownloadSizeLimitExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof DownloadSizeLimitExceededError) return true;
  const err = error as { name?: unknown; code?: unknown };
  return (
    err.name === DOWNLOAD_SIZE_LIMIT_EXCEEDED_NAME ||
    err.code === DOWNLOAD_SIZE_LIMIT_EXCEEDED_CODE ||
    err.code === 'DOWNLOAD_SIZE_LIMIT_EXCEEDED'
  );
}

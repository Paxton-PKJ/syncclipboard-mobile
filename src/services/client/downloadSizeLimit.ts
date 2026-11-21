import { File } from 'expo-file-system';
import { DownloadSizeLimitExceededError } from '@/errors';
import type { ClipboardContent } from '@/types/clipboard';

/** 复用缓存或其他调用的下载时，按落盘字节数执行当前调用者的限额。 */
export function checkDownloadedSize(
  content: ClipboardContent,
  maxBytes?: number
): ClipboardContent {
  if (maxBytes !== undefined && content.fileUri) {
    const file = new File(content.fileUri);
    if (!file.exists) throw new Error('Downloaded file is missing');
    if (file.size > maxBytes) throw new DownloadSizeLimitExceededError();
  }
  return content;
}

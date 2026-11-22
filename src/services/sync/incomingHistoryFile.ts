import { File } from 'expo-file-system';
import { nativeCopyFile, nativeReplaceFile } from 'native-util';
import type { ClipboardContent } from '@/types/clipboard';
import { getHistoryFileUri, prepareHistoryFileUri } from '@/utils/fileStorage';
import {
  calculateFileHash,
  calculateFileProfileHash,
  compareHash,
  isValidHash,
} from '@/utils/hash';

/** 将外部分享/拖入的暂存文件保存为持久副本，供上传、重试和远程卡片复用。 */
export async function prepareIncomingHistoryFile(
  content: ClipboardContent
): Promise<ClipboardContent> {
  if (!content.hasData) return content;
  const { type, fileName, profileHash, fileUri } = content;
  if (!fileName || !profileHash || !fileUri) throw new Error('Missing staged file metadata');
  const existing = await getHistoryFileUri(type, profileHash, fileName);
  if (existing) {
    if (existing !== fileUri) await ensureValidHistoryFile(existing, content);
    return { ...content, fileUri: existing };
  }
  const destination = await prepareHistoryFileUri(type, profileHash, fileName);
  await stageAndCommitNewHistoryFile(fileUri, destination, content);
  return { ...content, fileUri: destination };
}

function getFileByteSize(uri: string): number | undefined {
  try {
    const file = new File(uri);
    return file.exists ? file.size : undefined;
  } catch {
    return undefined;
  }
}

async function verifyFileAgainstRecord(
  fileUri: string,
  content: ClipboardContent
): Promise<'valid' | 'invalid' | 'unverifiable'> {
  const byteSize = getFileByteSize(fileUri);
  if (byteSize === undefined) {
    return 'invalid';
  }

  try {
    if (content.type === 'Text') {
      const expectedHash =
        content.profileHash && isValidHash(content.profileHash)
          ? content.profileHash
          : content.localClipboardHash && isValidHash(content.localClipboardHash)
            ? content.localClipboardHash
            : undefined;
      if (!expectedHash) {
        return 'unverifiable';
      }
      const actualHash = await calculateFileHash(fileUri);
      return compareHash(actualHash, expectedHash) ? 'valid' : 'invalid';
    }

    if (content.type === 'Image') {
      let checked = false;
      if (content.localClipboardHash && isValidHash(content.localClipboardHash)) {
        checked = true;
        const actualHash = await calculateFileHash(fileUri);
        if (!compareHash(actualHash, content.localClipboardHash)) {
          return 'invalid';
        }
      }
      if (content.profileHash && isValidHash(content.profileHash)) {
        checked = true;
        const actualProfileHash = await calculateFileProfileHash(fileUri, content.fileName);
        if (!compareHash(actualProfileHash, content.profileHash)) {
          return 'invalid';
        }
      }
      return checked ? 'valid' : 'unverifiable';
    }

    if (content.type === 'File') {
      if (content.profileHash && isValidHash(content.profileHash)) {
        const actualProfileHash = await calculateFileProfileHash(fileUri, content.fileName);
        return compareHash(actualProfileHash, content.profileHash) ? 'valid' : 'invalid';
      }
      return 'unverifiable';
    }

    // Group 的 profileHash 为未压缩条目的聚合哈希，无法直接从 zip 文件反推
    return 'unverifiable';
  } catch (error) {
    console.warn('[IncomingContent] Failed to verify file integrity:', error);
    return 'invalid';
  }
}

function getRecordedByteSize(content: ClipboardContent): number | undefined {
  return typeof content.fileSize === 'number' &&
    Number.isFinite(content.fileSize) &&
    content.fileSize >= 0
    ? content.fileSize
    : undefined;
}

async function ensureValidHistoryFile(
  existingUri: string,
  content: ClipboardContent
): Promise<void> {
  const existingVerdict = await verifyFileAgainstRecord(existingUri, content);
  if (existingVerdict === 'valid') {
    return;
  }

  const sourceUri = content.fileUri!;

  if (existingVerdict === 'invalid') {
    const sourceVerdict = await verifyFileAgainstRecord(sourceUri, content);
    if (sourceVerdict !== 'valid') {
      throw new Error(
        '[IncomingContent] source file failed integrity validation and cannot repair history file'
      );
    }
    await copyAndVerifyHistoryFile(sourceUri, existingUri, content);
    return;
  }

  // 记录本身无可直接校验的文件哈希（如 Group）：参考记录字节大小，优先保留有效历史文件
  const recordedSize = getRecordedByteSize(content);
  const existingSize = getFileByteSize(existingUri);
  const sourceSize = getFileByteSize(sourceUri);

  if (sourceSize === undefined || (recordedSize !== undefined && sourceSize !== recordedSize)) {
    if (
      existingSize !== undefined &&
      (recordedSize === undefined || existingSize === recordedSize)
    ) {
      return;
    }
    throw new Error('[IncomingContent] source file is missing or does not match expected size');
  }

  const [existingHash, sourceHash] = await Promise.all([
    calculateFileHash(existingUri),
    calculateFileHash(sourceUri),
  ]);
  if (compareHash(existingHash, sourceHash)) {
    return;
  }

  if (recordedSize !== undefined || existingSize === undefined || existingSize === 0) {
    await copyAndVerifyHistoryFile(sourceUri, existingUri, content, {
      expectedSize: recordedSize ?? sourceSize,
      expectedHash: sourceHash,
    });
  }
}

async function stageAndCommitNewHistoryFile(
  sourceUri: string,
  destUri: string,
  content: ClipboardContent
): Promise<void> {
  const sourceVerdict = await verifyFileAgainstRecord(sourceUri, content);
  if (sourceVerdict === 'invalid') {
    throw new Error('[IncomingContent] source file failed integrity validation');
  }

  if (sourceVerdict === 'valid') {
    await copyAndVerifyHistoryFile(sourceUri, destUri, content);
    return;
  }

  const recordedSize = getRecordedByteSize(content);
  const sourceSize = getFileByteSize(sourceUri);
  if (sourceSize === undefined || (recordedSize !== undefined && sourceSize !== recordedSize)) {
    throw new Error('[IncomingContent] source file is missing or does not match expected size');
  }

  const sourceHash = await calculateFileHash(sourceUri);
  await copyAndVerifyHistoryFile(sourceUri, destUri, content, {
    expectedSize: recordedSize ?? sourceSize,
    expectedHash: sourceHash,
  });
}

function createStagingUri(targetUri: string): string {
  const lastSlash = targetUri.lastIndexOf('/');
  const dir = lastSlash >= 0 ? targetUri.slice(0, lastSlash + 1) : '';
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${dir}.repair-${suffix}.tmp`;
}

function deleteFileQuietly(uri: string): void {
  try {
    const file = new File(uri);
    const exists = typeof file.exists === 'boolean' ? file.exists : true;
    if (exists && typeof file.delete === 'function') {
      file.delete();
    }
  } catch {
    // 忽略临时文件清理失败
  }
}

async function copyAndVerifyHistoryFile(
  sourceUri: string,
  targetUri: string,
  content: ClipboardContent,
  unverifiableCheck?: { expectedSize?: number; expectedHash: string }
): Promise<void> {
  const stagingUri = createStagingUri(targetUri);
  try {
    await nativeCopyFile(sourceUri, stagingUri);

    if (unverifiableCheck) {
      const stagedSize = getFileByteSize(stagingUri);
      if (
        stagedSize === undefined ||
        (unverifiableCheck.expectedSize !== undefined &&
          stagedSize !== unverifiableCheck.expectedSize)
      ) {
        throw new Error('[IncomingContent] Staged history file size mismatch');
      }
      const stagedHash = await calculateFileHash(stagingUri);
      if (!compareHash(stagedHash, unverifiableCheck.expectedHash)) {
        throw new Error('[IncomingContent] Staged history file hash mismatch');
      }
    } else {
      const stagedVerdict = await verifyFileAgainstRecord(stagingUri, content);
      if (stagedVerdict !== 'valid') {
        throw new Error('[IncomingContent] Staged history file failed integrity validation');
      }
    }

    await nativeReplaceFile(stagingUri, targetUri);
  } catch (error) {
    deleteFileQuietly(stagingUri);
    throw error;
  }
}

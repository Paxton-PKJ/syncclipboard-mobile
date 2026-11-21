/**
 * HistoryService
 * 作为 historyStore 与 HistoryStorage 之间的中间层，封装所有历史记录的 CRUD 操作。
 * 同时承担发布订阅职责：管理所有变更回调，HistoryStorage 不再直接维护订阅者列表。
 */

import { File } from 'expo-file-system';
import type { HistoryItem, ClipboardContent } from '@/types/clipboard';
import type { HistoryFilter, HistorySort } from '@/types/storage';
import type { HistoryChangeCallback } from '@/storage/HistoryStorage';
import { HistorySyncStatus } from '@/types/clipboard';
import { clipboardContentToItem } from '@/utils/clipboard/convert';
import { getHistoryFileUri, prepareHistoryFileUri } from '@/utils/fileStorage';
import {
  calculateFileHash,
  calculateFileProfileHash,
  compareHash,
  isValidHash,
} from '@/utils/hash';
import { nativeCopyFile, nativeReplaceFile } from 'native-util';
import { historyStorage } from '@/storage';

/**
 * HistoryService - 历史记录业务服务
 * 作为 historyStore 和 HistoryStorage 之间的中间层，封装所有历史记录的 CRUD 操作，
 * 并统一管理变更通知的发布订阅。
 */
export class HistoryService {
  private changeCallbacks = new Set<HistoryChangeCallback>();
  private silentMode = false;

  constructor() {
    // 注册为 HistoryStorage 的唯一通知接收方，再由本服务向订阅者分发
    historyStorage.setOnChangeCallback((items, action) => {
      if (this.silentMode) return;
      for (const cb of this.changeCallbacks) {
        try {
          cb(items, action);
        } catch (error) {
          console.error('[HistoryService] Error in change callback:', error);
        }
      }
    });
  }
  // ── CRUD ──────────────────────────────────────────────

  searchItems(
    filter?: HistoryFilter,
    sort?: HistorySort
  ): Promise<{ items: HistoryItem[]; total: number }> {
    return historyStorage.searchItems(filter, sort);
  }

  getItem(profileHash: string): Promise<HistoryItem | null> {
    return historyStorage.getItem(profileHash);
  }

  addItem(item: HistoryItem): Promise<HistoryItem> {
    return historyStorage.addItem(item);
  }

  addRemoteContent(content: ClipboardContent): Promise<HistoryItem> {
    const historyItem = clipboardContentToItem(content, {
      syncStatus: HistorySyncStatus.Synced,
    });

    return historyStorage.addItem(historyItem);
  }

  async addLocalContent(content: ClipboardContent): Promise<HistoryItem> {
    let fileUri: string | undefined;

    if (content.hasData) {
      if (!content.fileName || !content.profileHash) {
        throw new Error(
          '[HistoryService] addLocalContent: fileName and profileHash are required when hasData is true'
        );
      }

      const existingUri = await getHistoryFileUri(
        content.type,
        content.profileHash,
        content.fileName
      );

      if (existingUri) {
        if (content.fileUri && content.fileUri !== existingUri) {
          await this.ensureValidHistoryFile(existingUri, content);
        }
        fileUri = existingUri;
      } else if (content.fileUri) {
        const destUri = await prepareHistoryFileUri(
          content.type,
          content.profileHash,
          content.fileName
        );
        await this.stageAndCommitNewHistoryFile(content.fileUri, destUri, content);
        fileUri = destUri;
      } else {
        throw new Error(
          '[HistoryService] addLocalContent: fileUri is required when hasData is true and file does not exist in history'
        );
      }
    }

    const historyItem = clipboardContentToItem(content, {
      fileUri,
      syncStatus: HistorySyncStatus.LocalOnly,
    });

    return historyStorage.addItem(historyItem);
  }

  private getFileByteSize(uri: string): number | undefined {
    try {
      const file = new File(uri);
      const info = typeof file.info === 'function' ? file.info() : undefined;
      if (info && typeof info.exists === 'boolean') {
        if (!info.exists) return undefined;
        return typeof info.size === 'number' && Number.isFinite(info.size)
          ? info.size
          : typeof file.size === 'number' && Number.isFinite(file.size)
            ? file.size
            : undefined;
      }
      if (typeof file.exists === 'boolean' && !file.exists) {
        return undefined;
      }
      return typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : undefined;
    } catch {
      return undefined;
    }
  }

  private async verifyFileAgainstRecord(
    fileUri: string,
    content: ClipboardContent
  ): Promise<'valid' | 'invalid' | 'unverifiable'> {
    const byteSize = this.getFileByteSize(fileUri);
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
      console.warn('[HistoryService] Failed to verify file integrity:', error);
      return 'invalid';
    }
  }

  private getRecordedByteSize(content: ClipboardContent): number | undefined {
    return typeof content.fileSize === 'number' &&
      Number.isFinite(content.fileSize) &&
      content.fileSize >= 0
      ? content.fileSize
      : undefined;
  }

  private async ensureValidHistoryFile(
    existingUri: string,
    content: ClipboardContent
  ): Promise<void> {
    const existingVerdict = await this.verifyFileAgainstRecord(existingUri, content);
    if (existingVerdict === 'valid') {
      return;
    }

    const sourceUri = content.fileUri!;

    if (existingVerdict === 'invalid') {
      const sourceVerdict = await this.verifyFileAgainstRecord(sourceUri, content);
      if (sourceVerdict !== 'valid') {
        throw new Error(
          '[HistoryService] addLocalContent: source file failed integrity validation and cannot repair history file'
        );
      }
      await this.copyAndVerifyHistoryFile(sourceUri, existingUri, content);
      return;
    }

    // 记录本身无可直接校验的文件哈希（如 Group）：参考记录字节大小，优先保留有效历史文件
    const recordedSize = this.getRecordedByteSize(content);
    const existingSize = this.getFileByteSize(existingUri);
    const sourceSize = this.getFileByteSize(sourceUri);

    if (sourceSize === undefined || (recordedSize !== undefined && sourceSize !== recordedSize)) {
      if (
        existingSize !== undefined &&
        (recordedSize === undefined || existingSize === recordedSize)
      ) {
        return;
      }
      throw new Error(
        '[HistoryService] addLocalContent: source file is missing or does not match expected size'
      );
    }

    const [existingHash, sourceHash] = await Promise.all([
      calculateFileHash(existingUri),
      calculateFileHash(sourceUri),
    ]);
    if (compareHash(existingHash, sourceHash)) {
      return;
    }

    if (recordedSize !== undefined || existingSize === undefined || existingSize === 0) {
      await this.copyAndVerifyHistoryFile(sourceUri, existingUri, content, {
        expectedSize: recordedSize ?? sourceSize,
        expectedHash: sourceHash,
      });
    }
  }

  private async stageAndCommitNewHistoryFile(
    sourceUri: string,
    destUri: string,
    content: ClipboardContent
  ): Promise<void> {
    const sourceVerdict = await this.verifyFileAgainstRecord(sourceUri, content);
    if (sourceVerdict === 'invalid') {
      throw new Error('[HistoryService] addLocalContent: source file failed integrity validation');
    }

    if (sourceVerdict === 'valid') {
      await this.copyAndVerifyHistoryFile(sourceUri, destUri, content);
      return;
    }

    const recordedSize = this.getRecordedByteSize(content);
    const sourceSize = this.getFileByteSize(sourceUri);
    if (sourceSize === undefined || (recordedSize !== undefined && sourceSize !== recordedSize)) {
      throw new Error(
        '[HistoryService] addLocalContent: source file is missing or does not match expected size'
      );
    }

    const sourceHash = await calculateFileHash(sourceUri);
    await this.copyAndVerifyHistoryFile(sourceUri, destUri, content, {
      expectedSize: recordedSize ?? sourceSize,
      expectedHash: sourceHash,
    });
  }

  private createStagingUri(targetUri: string): string {
    const lastSlash = targetUri.lastIndexOf('/');
    const dir = lastSlash >= 0 ? targetUri.slice(0, lastSlash + 1) : '';
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return `${dir}.repair-${suffix}.tmp`;
  }

  private deleteFileQuietly(uri: string): void {
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

  private async copyAndVerifyHistoryFile(
    sourceUri: string,
    targetUri: string,
    content: ClipboardContent,
    unverifiableCheck?: { expectedSize?: number; expectedHash: string }
  ): Promise<void> {
    const stagingUri = this.createStagingUri(targetUri);
    try {
      await nativeCopyFile(sourceUri, stagingUri);

      if (unverifiableCheck) {
        const stagedSize = this.getFileByteSize(stagingUri);
        if (
          stagedSize === undefined ||
          (unverifiableCheck.expectedSize !== undefined &&
            stagedSize !== unverifiableCheck.expectedSize)
        ) {
          throw new Error('[HistoryService] Staged history file size mismatch');
        }
        const stagedHash = await calculateFileHash(stagingUri);
        if (!compareHash(stagedHash, unverifiableCheck.expectedHash)) {
          throw new Error('[HistoryService] Staged history file hash mismatch');
        }
      } else {
        const stagedVerdict = await this.verifyFileAgainstRecord(stagingUri, content);
        if (stagedVerdict !== 'valid') {
          throw new Error('[HistoryService] Staged history file failed integrity validation');
        }
      }

      await nativeReplaceFile(stagingUri, targetUri);
    } catch (error) {
      this.deleteFileQuietly(stagingUri);
      throw error;
    }
  }

  addItems(items: HistoryItem[]): Promise<void> {
    return historyStorage.addItems(items);
  }

  updateItem(profileHash: string, updates: Partial<HistoryItem>): Promise<void> {
    return historyStorage.updateItem(profileHash, updates);
  }

  softDeleteItem(profileHash: string): Promise<void> {
    return historyStorage.softDeleteItem(profileHash);
  }

  softDeleteItems(profileHashes: string[]): Promise<void> {
    return historyStorage.softDeleteItems(profileHashes);
  }

  toggleStar(profileHash: string): Promise<boolean> {
    return historyStorage.toggleStar(profileHash);
  }

  togglePin(profileHash: string): Promise<boolean> {
    return historyStorage.togglePin(profileHash);
  }

  incrementUseCount(profileHash: string): Promise<void> {
    return historyStorage.incrementUseCount(profileHash);
  }

  clear(): Promise<void> {
    return historyStorage.clear().then(() => {
      // 向订阅者发送 clear 事件
      if (!this.silentMode) {
        for (const cb of this.changeCallbacks) {
          try {
            cb([], 'clear');
          } catch (error) {
            console.error('[HistoryService] Error in clear callback:', error);
          }
        }
      }
    });
  }

  setSortConfig(sort: HistorySort): void {
    historyStorage.setSortConfig(sort);
  }

  // ── 发布订阅 ─────────────────────────────────────────

  addChangeCallback(callback: HistoryChangeCallback): void {
    this.changeCallbacks.add(callback);
  }

  removeChangeCallback(callback: HistoryChangeCallback): void {
    this.changeCallbacks.delete(callback);
  }

  /** 进入静默模式：暂停向订阅者分发通知 */
  beginSilentMode(): void {
    this.silentMode = true;
  }

  /** 退出静默模式：恢复通知分发 */
  endSilentMode(): void {
    this.silentMode = false;
  }
}

/** HistoryService 单例 */
export const historyService = new HistoryService();

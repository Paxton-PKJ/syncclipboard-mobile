/**
 * ClipboardChangedHandler
 * 处理远程和本地剪贴板变化的业务逻辑
 */

import { AppState, Platform, ToastAndroid } from 'react-native';
import { ClipboardContent } from '../../types/clipboard';
import type { AppConfig } from '../../types';
import { clipboardSyncState } from './SyncState';
import { configService } from '../ConfigService';
import { remoteClipboardMonitor } from './RemoteClipboardMonitor';
import { uploadLocalClipboard, downloadRemoteClipboard } from './ClipboardSyncActions';
import {
  getJustUploadedHash,
  clearJustUploadedHash,
  getJustSetLocalHash,
  clearJustSetLocalHash,
} from './JustSetHash';
import { updateForegroundNotification } from '../notification/ForegroundNotification';
import { historyService } from '../history/HistoryService';
import { localClipboard } from '../clipboard/LocalClipboard';
import { calculateTextHash } from '../../utils/hash';
import i18n from '@/i18n';
import { isDownloadSizeLimitExceededError } from '@/errors';
import { logStartupPoint, getStartupElapsedMs } from '../StartupTiming';

const STARTUP_BASELINE_WINDOW_MS = 2_000;
const UTF8_MAX_BYTES_PER_UTF16_UNIT = 3;

type AutoDownloadDecision =
  | { action: 'download' }
  | { action: 'downloadWithLimit'; maxBytes: number }
  | { action: 'skip'; reason: string };

/** 判断下一次剪贴板内容是否应仅作为应用启动基线。 */
function shouldUseStartupBaseline(
  previousHash: string | null,
  direction: 'local' | 'remote'
): boolean {
  const appUptimeMs = getStartupElapsedMs();
  const useBaseline =
    previousHash === null && appUptimeMs >= 0 && appUptimeMs < STARTUP_BASELINE_WINDOW_MS;
  logStartupPoint(`${direction}.firstBaselineDecision`, {
    decisionUptimeMs: Math.round(appUptimeMs),
    windowMs: STARTUP_BASELINE_WINDOW_MS,
    hadPreviousHash: previousHash !== null,
    useBaseline,
    appState: AppState.currentState,
  });
  return useBaseline;
}

class ClipboardChangedHandler {
  private static instance: ClipboardChangedHandler | null = null;
  private lastRemoteProfileHash: string | null = null;
  private lastLocalProfileHash: string | null = null;

  private constructor() {}

  static getInstance(): ClipboardChangedHandler {
    if (!ClipboardChangedHandler.instance) {
      ClipboardChangedHandler.instance = new ClipboardChangedHandler();
    }
    return ClipboardChangedHandler.instance;
  }

  resetLastRemoteProfileHash(): void {
    this.lastRemoteProfileHash = null;
  }

  resetLastLocalProfileHash(): void {
    this.lastLocalProfileHash = null;
  }

  resetHashes(): void {
    this.lastRemoteProfileHash = null;
    this.lastLocalProfileHash = null;
  }

  setLastRemoteProfileHash(hash: string): void {
    this.lastRemoteProfileHash = hash;
  }

  setLastLocalProfileHash(hash: string): void {
    this.lastLocalProfileHash = hash;
  }

  async processRemoteClipboardContent(content: ClipboardContent): Promise<void> {
    const isStartupBaseline = shouldUseStartupBaseline(this.lastRemoteProfileHash, 'remote');

    if (!content.hasData && content.type === 'Text' && !content.profileHash && content.text) {
      content.profileHash = await calculateTextHash(content.text);
    }

    const currentHash = content.profileHash || content.text;

    // 如果匹配刚上传的 hash，跳过处理
    if (currentHash && currentHash === getJustUploadedHash()) {
      console.log('[ClipboardChangedHandler] Ignoring remote content with hash:', currentHash);
      // 清除刚上传 hash（只忽略一次）
      clearJustUploadedHash();
      // 更新 lastRemoteProfileHash，防止后续重复处理
      this.lastRemoteProfileHash = currentHash;
      return;
    }
    clearJustUploadedHash();

    // 仅在 hash 变化时更新 state，避免覆盖已下载的 fileUri 等状态
    const stateRemote = clipboardSyncState.getState().remoteContent;
    const stateHash = stateRemote?.profileHash || stateRemote?.text;
    if (currentHash !== stateHash) {
      clipboardSyncState.setRemoteContent(content);
    }

    const config = await configService.getConfig();
    if (currentHash === this.lastRemoteProfileHash) return;
    this.lastRemoteProfileHash = currentHash;

    let fileUri: string | undefined;

    if (content.profileHash) {
      const addedItem = await historyService.addRemoteContent(content);
      fileUri = addedItem.fileUri;
    }

    if (fileUri && !content.fileUri) {
      console.log('[ClipboardChangedHandler] Found existing file in history');
      content = { ...content, fileUri };
    } else if (content.hasData && content.fileName) {
      const downloadedContent = await this.tryAutoDownload(content, config);
      if (!downloadedContent) {
        return;
      }
      content = downloadedContent;
    }

    clipboardSyncState.setRemoteContent(content);

    if (isStartupBaseline) return;

    await this.tryAutoCopyToClipboard(content, config);
  }

  private resolveAutoDownloadDecision(
    content: ClipboardContent,
    autoDownloadMaxSize: number
  ): AutoDownloadDecision {
    if (
      typeof content.fileSize === 'number' &&
      Number.isFinite(content.fileSize) &&
      content.fileSize >= 0
    ) {
      return content.fileSize <= autoDownloadMaxSize
        ? { action: 'download' }
        : {
            action: 'skip',
            reason: `Content too large (${content.fileSize} > ${autoDownloadMaxSize})`,
          };
    }
    if (
      content.type === 'Text' &&
      typeof content.textLength === 'number' &&
      Number.isFinite(content.textLength) &&
      content.textLength > 0
    ) {
      // 服务端 TextProfile.size 为 UTF-16 字符数而非字节数；
      // 合法 UTF-8 下每个 UTF-16 代码单元占 1~3 字节：
      // 最坏上界未超限直接放行；最小下界已超限直接跳过；介于两者之间时在下载流中执行硬上限。
      const minBytes = content.textLength;
      const maxBytes = content.textLength * UTF8_MAX_BYTES_PER_UTF16_UNIT;
      if (maxBytes <= autoDownloadMaxSize) {
        return { action: 'download' };
      }
      if (minBytes > autoDownloadMaxSize) {
        return {
          action: 'skip',
          reason: `Content too large (min ${minBytes} > ${autoDownloadMaxSize})`,
        };
      }
      return { action: 'downloadWithLimit', maxBytes: autoDownloadMaxSize };
    }
    return { action: 'skip', reason: 'Content byte size unknown' };
  }

  private async tryAutoDownload(
    content: ClipboardContent,
    config: AppConfig
  ): Promise<ClipboardContent | null> {
    const autoDownloadMaxSize = config?.autoDownloadMaxSize ?? 5 * 1024 * 1024;
    const decision = this.resolveAutoDownloadDecision(content, autoDownloadMaxSize);

    if (decision.action === 'skip') {
      console.log(`[ClipboardChangedHandler] ${decision.reason}, skipping auto-download`);
      return null;
    }

    try {
      const result =
        decision.action === 'downloadWithLimit'
          ? await downloadRemoteClipboard(content, undefined, undefined, {
              maxBytes: decision.maxBytes,
            })
          : await downloadRemoteClipboard(content);
      console.log('[ClipboardChangedHandler] Auto-download completed');
      return result;
    } catch (error) {
      if (isDownloadSizeLimitExceededError(error)) {
        console.log(
          `[ClipboardChangedHandler] Content exceeded auto-download limit (${autoDownloadMaxSize} bytes), skipping auto-download`
        );
        return null;
      }
      const err = error as Error;
      if (err?.name !== 'AbortError') {
        console.error('[ClipboardChangedHandler] Auto-download failed:', error);
      }
      return null;
    }
  }

  private async tryAutoCopyToClipboard(
    content: ClipboardContent,
    config: AppConfig
  ): Promise<void> {
    if (content.type !== 'Text' && content.type !== 'Image') return;
    if (content.type === 'Text' && content.hasData && !content.fileUri) return;
    if (content.type === 'Image' && (config.autoCopyTextOnly || !content.fileUri)) return;

    const autoSyncEnabled = config?.autoSync ?? false;
    const bgDownloadEnabled = !!(config?.enableBackgroundTasks && config?.enableBackgroundDownload);
    const isAppActive = AppState.currentState === 'active';
    const shouldAutoCopy = autoSyncEnabled || (!isAppActive && bgDownloadEnabled);

    if (!shouldAutoCopy) return;

    const remoteHash = content.profileHash || content.text;
    const localMatchesRemote = remoteHash === this.lastLocalProfileHash;
    const activeServer = await configService.getActiveServer();

    if (localMatchesRemote || !activeServer) {
      return;
    }

    if (!content.text && !content.fileUri) {
      console.log('[ClipboardChangedHandler] No content available for auto-copy');
      return;
    }

    try {
      await this.copyToLocalClipboard(content);
      if (Platform.OS === 'android') {
        const preview = this.getContentPreview(content);
        updateForegroundNotification(false, preview);
        if (config?.syncToastEnabled !== false) {
          ToastAndroid.show(i18n.t('common.downloaded', { preview }), ToastAndroid.SHORT);
        }
      }
    } catch (error) {
      console.error('[ClipboardChangedHandler] Auto-copy failed:', error);
    }
  }

  private getContentPreview(content: ClipboardContent): string {
    if (content.type === 'Text' && content.text) {
      return content.text.trim().replace(/\s+/g, ' ').slice(0, 30);
    }
    return content.fileName || content.type;
  }

  private async copyToLocalClipboard(content: ClipboardContent): Promise<void> {
    await localClipboard.setClipboardContent(content, true);
    this.lastLocalProfileHash = content.profileHash || content.text;
    console.log('[ClipboardChangedHandler] Copied to local clipboard');
  }

  async handleAutoUpload(content: ClipboardContent): Promise<void> {
    const isStartupBaseline = shouldUseStartupBaseline(this.lastLocalProfileHash, 'local');
    const config = await configService.getConfig();

    const autoSync = config?.autoSync ?? false;
    const bgUpload = config?.enableBackgroundTasks && config?.enableBackgroundUpload;
    if (!autoSync && !bgUpload) return;

    const activeServer = await configService.getActiveServer();
    if (!activeServer) return;

    const currentHash = content.profileHash || content.text;

    // 如果匹配刚设置到本地剪贴板的 hash，跳过自动上传
    if (currentHash && currentHash === getJustSetLocalHash()) {
      console.log(
        '[ClipboardChangedHandler] Ignoring local content just set from remote:',
        currentHash
      );
      // 清除刚设置 hash（只忽略一次）
      clearJustSetLocalHash();
      // 更新 lastLocalProfileHash，防止后续重复处理
      this.lastLocalProfileHash = currentHash;
      return;
    }
    clearJustSetLocalHash();

    if (currentHash === this.lastLocalProfileHash) return;
    this.lastLocalProfileHash = currentHash;
    if (isStartupBaseline) return;

    try {
      const uploaded = await uploadLocalClipboard(content);
      if (uploaded && Platform.OS === 'android') {
        const preview = this.getContentPreview(content);
        updateForegroundNotification(true, preview);
        if (config?.syncToastEnabled !== false) {
          ToastAndroid.show(i18n.t('common.uploaded', { preview }), ToastAndroid.SHORT);
        }
        remoteClipboardMonitor.refresh().catch(() => {});
      }
    } catch (e: unknown) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        console.error('[ClipboardChangedHandler] Auto-upload failed:', e);
      }
    }
  }
}

export function getClipboardChangedHandler(): ClipboardChangedHandler {
  return ClipboardChangedHandler.getInstance();
}

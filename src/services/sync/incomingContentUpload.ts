import {
  awaitIncomingSession,
  cleanupIncomingSession,
  type IncomingSessionMeta,
  type IncomingSessionPayload,
  type IncomingSessionProgressEvent,
  type ProgressInfo,
} from 'native-util';
import {
  createContentFromFile,
  createContentFromMultipleFiles,
  createContentFromText,
  type CreateContentFromFileOptions,
  type MultipleFileEntry,
} from '@/utils/clipboard/clipboardContentUtils';
import { setRemoteClipboard } from '@/services/sync/ClipboardSyncActions';
import type { ClipboardContent } from '@/types/clipboard';

export type IncomingTranslationKey =
  | 'shareReceive.stageAgain'
  | 'shareReceive.noContent'
  | 'shareReceive.emptyText'
  | 'shareReceive.stagingFile'
  | 'shareReceive.stagingMultipleFiles'
  | 'shareReceive.stagingFileProgress'
  | 'shareReceive.uploadingText'
  | 'shareReceive.uploadingFile'
  | 'shareReceive.processingMultipleFiles'
  | 'shareReceive.processingFileProgress'
  | 'dropReceive.mixedContentUnsupported';

export interface IncomingUploadCallbacks {
  setLoadingText: (text: string) => void;
  setProgress: (progress: ProgressInfo | null) => void;
  setPreviewText: (text: string | undefined) => void;
  setPreviewImage: (uri: string | undefined) => void;
  t: (key: IncomingTranslationKey, options?: Record<string, unknown>) => string;
}

export interface IncomingUploadDeps {
  awaitSession: (
    sessionId: string,
    signal?: AbortSignal,
    onProgress?: (event: IncomingSessionProgressEvent) => void
  ) => Promise<IncomingSessionPayload>;
  cleanupSession: (sessionId: string) => void;
  createContentFromText: (
    text: string,
    options?: { signal?: AbortSignal }
  ) => Promise<ClipboardContent>;
  createContentFromFile: (
    sourceUri: string,
    fileName: string,
    mimeType?: string | null,
    fileSize?: number,
    options?: CreateContentFromFileOptions
  ) => Promise<ClipboardContent>;
  createContentFromMultipleFiles: (
    entries: MultipleFileEntry[],
    options?: CreateContentFromFileOptions
  ) => Promise<ClipboardContent>;
  setRemoteClipboard: (
    content: ClipboardContent,
    signal: AbortSignal,
    onProgress?: (info: ProgressInfo) => void
  ) => Promise<boolean>;
}

const defaultDeps: IncomingUploadDeps = {
  awaitSession: awaitIncomingSession,
  cleanupSession: cleanupIncomingSession,
  createContentFromText,
  createContentFromFile,
  createContentFromMultipleFiles,
  setRemoteClipboard,
};

/** 当前会话无法再产生可上传的内容。 */
class UnavailableIncomingContentError extends Error {}

export function canRetryIncomingUpload(error: Error): boolean {
  return !(error instanceof UnavailableIncomingContentError);
}

/**
 * 共享的外部传入内容（系统分享 / 拖放）上传编排：
 * 等待原生后台暂存完成 → 构建 ClipboardContent → 上传到远程剪贴板并同步历史记录。
 * 仅在成功或主动取消时清理临时目录；网络失败保留暂存文件以支持 QuickLoadingPage 重试。
 */
export async function uploadIncomingSession(
  session: IncomingSessionMeta,
  signal: AbortSignal,
  callbacks: IncomingUploadCallbacks,
  deps: IncomingUploadDeps = defaultDeps
): Promise<void> {
  const { setLoadingText, setProgress, setPreviewText, setPreviewImage, t } = callbacks;

  if (session.kind === 'unsupported_mixed') {
    throw new UnavailableIncomingContentError(t('dropReceive.mixedContentUnsupported'));
  }

  if (!session.sessionId || session.kind === 'empty') {
    throw new UnavailableIncomingContentError(t('shareReceive.noContent'));
  }

  if (session.kind === 'text') {
    setLoadingText(t('shareReceive.uploadingText'));
    setPreviewText(session.previewText);
    setPreviewImage(undefined);
  } else if (session.kind === 'multiple') {
    setLoadingText(t('shareReceive.stagingMultipleFiles', { count: session.itemCount }));
    setPreviewText(undefined);
    setPreviewImage(undefined);
  } else {
    setLoadingText(t('shareReceive.stagingFile'));
    setPreviewText(undefined);
    setPreviewImage(undefined);
  }

  try {
    const payload = await deps
      .awaitSession(session.sessionId, signal, (event) => {
        if (event.totalFiles > 1) {
          setLoadingText(
            t('shareReceive.stagingFileProgress', {
              current: event.currentFile,
              total: event.totalFiles,
            })
          );
        } else {
          setLoadingText(t('shareReceive.stagingFile'));
        }
        setProgress({
          progress: event.totalBytes > 0 ? Math.min(1, event.bytesCopied / event.totalBytes) : -1,
          bytesTransferred: event.bytesCopied,
          totalBytes: event.totalBytes,
        });
      })
      .catch((error: unknown) => {
        if (signal.aborted) throw error;
        const hint = t('shareReceive.stageAgain');
        throw new UnavailableIncomingContentError(
          error instanceof Error
            ? `${hint}
${error.message}`
            : hint
        );
      });

    setProgress(null);

    if (payload.type === 'text') {
      const text = payload.text ?? '';
      if (!text.trim()) {
        throw new UnavailableIncomingContentError(t('shareReceive.emptyText'));
      }
      setLoadingText(t('shareReceive.uploadingText'));
      setPreviewText(text.slice(0, 100));
      setPreviewImage(undefined);
      const textContent = await deps.createContentFromText(text, { signal });
      await deps.setRemoteClipboard(textContent, signal);
      deps.cleanupSession(session.sessionId);
      return;
    }

    if (payload.type === 'file' && payload.file) {
      const { uri, fileName, mimeType, size } = payload.file;
      setLoadingText(t('shareReceive.uploadingFile'));
      setPreviewText(fileName);
      setPreviewImage(mimeType.startsWith('image/') ? uri : undefined);

      const content = await deps.createContentFromFile(
        uri,
        fileName,
        mimeType,
        size > 0 ? size : undefined,
        {
          signal,
          skipTempCopy: true,
        }
      );

      await deps.setRemoteClipboard(content, signal, (info) => {
        setProgress(info ?? null);
      });
      deps.cleanupSession(session.sessionId);
      return;
    }

    if (payload.type === 'multiple' && payload.files && payload.files.length > 0) {
      const entries = payload.files.map((file) => ({
        uri: file.uri,
        fileName: file.fileName,
      }));
      setLoadingText(t('shareReceive.processingMultipleFiles', { count: entries.length }));
      setPreviewText(entries.map((entry) => entry.fileName).join(', '));
      setPreviewImage(undefined);

      const content = await deps.createContentFromMultipleFiles(entries, {
        signal,
        onProgress: ({ current, total }) => {
          setLoadingText(t('shareReceive.processingFileProgress', { current, total }));
        },
      });

      setLoadingText(t('shareReceive.uploadingFile'));
      await deps.setRemoteClipboard(content, signal, (info) => {
        setProgress(info ?? null);
      });
      deps.cleanupSession(session.sessionId);
      return;
    }

    throw new UnavailableIncomingContentError(t('shareReceive.noContent'));
  } catch (error) {
    if (signal.aborted) {
      deps.cleanupSession(session.sessionId);
    }
    throw error;
  }
}

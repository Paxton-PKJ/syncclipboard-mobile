import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { cleanupIncomingSession, type IncomingSessionMeta, type ProgressInfo } from 'native-util';
import { useTheme } from '@/hooks/useTheme';
import { QuickLoadingPage } from '@/components/QuickLoadingPage';
import {
  canRetryIncomingUpload,
  uploadIncomingSession,
} from '@/services/sync/incomingContentUpload';
import { networkAutoSwitchService } from '@/services/NetworkAutoSwitchService';
import { useMessageStore } from '@/stores/messageStore';

interface DropHoverOverlayProps {
  visible: boolean;
  entered: boolean;
  hasActiveServer: boolean;
}

/**
 * 外部拖入悬停时的全屏半透明提示遮罩。
 */
export const DropHoverOverlay: React.FC<DropHoverOverlayProps> = ({
  visible,
  entered,
  hasActiveServer,
}) => {
  const { theme } = useTheme();
  const { t } = useTranslation();

  if (!visible) return null;

  const accentColor = !hasActiveServer
    ? theme.colors.warning
    : entered
      ? theme.colors.primary
      : theme.colors.border;

  const hintText = !hasActiveServer
    ? t('dropReceive.noServerHint')
    : entered
      ? t('dropReceive.releaseHint')
      : t('dropReceive.hoverHint');

  return (
    <View
      pointerEvents="none"
      style={[styles.hoverContainer, { backgroundColor: theme.colors.backdrop }]}
    >
      <View
        style={[
          styles.dropCard,
          {
            backgroundColor: theme.colors.surface,
            borderColor: accentColor,
          },
        ]}
      >
        <Ionicons
          name={hasActiveServer ? 'cloud-upload-outline' : 'alert-circle-outline'}
          size={44}
          color={hasActiveServer ? theme.colors.primary : theme.colors.warning}
        />
        <Text style={[styles.hoverTitle, { color: theme.colors.text }]}>{hintText}</Text>
      </View>
    </View>
  );
};

interface DropUploadOverlayProps {
  session: IncomingSessionMeta;
  onComplete: () => void;
}

/**
 * 拖入松手后的上传浮层，复用 QuickLoadingPage 的进度、预览、取消与重试能力。
 */
export const DropUploadOverlay: React.FC<DropUploadOverlayProps> = ({ session, onComplete }) => {
  const { t } = useTranslation();
  const [loadingText, setLoadingText] = useState(() => t('shareReceive.processingFile'));
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [previewText, setPreviewText] = useState<string | undefined>(session.previewText);
  const [previewImage, setPreviewImage] = useState<string | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (session.sessionId && session.kind !== 'unsupported_mixed') {
        cleanupIncomingSession(session.sessionId);
      }
    };
  }, [session.kind, session.sessionId]);

  const task = useCallback(
    async (signal: AbortSignal) => {
      try {
        await networkAutoSwitchService.ensureCurrentServer();
      } catch (error) {
        console.error('[DropUploadOverlay] Network auto-switch preflight failed:', error);
      }

      await uploadIncomingSession(session, signal, {
        setLoadingText,
        setProgress,
        setPreviewText,
        setPreviewImage,
        t,
      });

      useMessageStore.getState().showMessage(t('dropReceive.success'), 'success');
    },
    [session, t]
  );

  return (
    <QuickLoadingPage
      task={task}
      loadingText={loadingText}
      successText={t('dropReceive.success')}
      failureText={t('dropReceive.failed')}
      onComplete={onComplete}
      progress={progress}
      previewText={previewText}
      previewImage={previewImage}
      overlayMode
      allowRetry={canRetryIncomingUpload}
    />
  );
};

const styles = StyleSheet.create({
  hoverContainer: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    zIndex: 20,
    elevation: 20,
  },
  dropCard: {
    width: '100%',
    maxWidth: 320,
    borderRadius: 16,
    borderWidth: 2,
    borderStyle: 'dashed',
    paddingVertical: 32,
    paddingHorizontal: 24,
    alignItems: 'center',
    gap: 12,
  },
  hoverTitle: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 22,
  },
});

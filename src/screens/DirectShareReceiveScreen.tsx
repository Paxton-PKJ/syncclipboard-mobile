/**
 * Direct Share Receive Screen
 * 通过原生共享会话接收来自 ShareActivity 的分享内容，并驱动 QuickLoadingPage 上传。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cleanupIncomingSession, type IncomingSessionMeta, type ProgressInfo } from 'native-util';
import { QuickLoadingPage } from '@/components/QuickLoadingPage';
import {
  canRetryIncomingUpload,
  uploadIncomingSession,
} from '@/services/sync/incomingContentUpload';

interface DirectShareReceiveScreenProps {
  session: IncomingSessionMeta;
  onComplete: () => void;
  overlayMode?: boolean;
}

export const DirectShareReceiveScreen: React.FC<DirectShareReceiveScreenProps> = ({
  session,
  onComplete,
  overlayMode = false,
}) => {
  const { t } = useTranslation();
  const [loadingText, setLoadingText] = useState(() => t('shareReceive.processingFile'));
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [previewText, setPreviewText] = useState<string | undefined>(session.previewText);
  const [previewImage, setPreviewImage] = useState<string | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (session.sessionId) {
        cleanupIncomingSession(session.sessionId);
      }
    };
  }, [session.sessionId]);

  const task = useCallback(
    async (signal: AbortSignal) => {
      await uploadIncomingSession(session, signal, {
        setLoadingText,
        setProgress,
        setPreviewText,
        setPreviewImage,
        t,
      });
    },
    [session, t]
  );

  return (
    <QuickLoadingPage
      task={task}
      loadingText={loadingText}
      successText={t('shareReceive.success')}
      failureText={t('shareReceive.failed')}
      onComplete={onComplete}
      progress={progress}
      previewText={previewText}
      previewImage={previewImage}
      overlayMode={overlayMode}
      allowRetry={canRetryIncomingUpload}
    />
  );
};

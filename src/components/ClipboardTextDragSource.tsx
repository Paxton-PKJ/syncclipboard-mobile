import React, { useEffect, useRef } from 'react';
import { Platform, View } from 'react-native';
import {
  HistoryDragSource,
  HistoryGestureSurface,
  type HistoryDragItem,
  type HistoryDragRequest,
  type HistoryGestureSurfaceHandle,
} from 'native-util';
import { useTranslation } from 'react-i18next';
import { useMessageStore } from '@/stores/messageStore';

interface ClipboardTextDragSourceProps {
  item: HistoryDragItem | null;
  children: React.ReactNode;
}

/** 单项文本沿用原生拖拽会话；只包裹预览，保留卡片按钮和滚动行为。 */
export function ClipboardTextDragSource({ item, children }: ClipboardTextDragSourceProps) {
  const surfaceRef = useRef<HistoryGestureSurfaceHandle | null>(null);
  const currentItemRef = useRef(item);
  const epochRef = useRef(0);
  const mountedRef = useRef(true);
  const { t } = useTranslation();
  const { showMessage } = useMessageStore();
  if (currentItemRef.current !== item) {
    currentItemRef.current = item;
    epochRef.current += 1;
  }

  useEffect(() => {
    mountedRef.current = true;
    const surface = surfaceRef.current;
    return () => {
      mountedRef.current = false;
      // 原生 cancelGesture 仅取消准备；已开始的系统拖拽保留接收方的读取窗口。
      void surface?.cancelGesture().catch(() => {});
    };
  }, [item]);

  const handleDragRequested = async ({ gestureId, sourceId }: HistoryDragRequest) => {
    if (!item || sourceId !== item.id || Platform.OS !== 'android') return;
    const isCurrent = () => mountedRef.current && currentItemRef.current === item;
    try {
      const result = await surfaceRef.current?.startDrag(gestureId, [item]);
      if (!isCurrent() || !result || result.started || result.code === 'CANCELLED') return;
      showMessage(
        t(
          result.code === 'PAYLOAD_TOO_LARGE'
            ? 'clipboard.textDragTooLarge'
            : 'clipboard.textDragFailed'
        ),
        'error'
      );
    } catch {
      if (isCurrent()) showMessage(t('clipboard.textDragFailed'), 'error');
    }
  };

  if (Platform.OS !== 'android') return <View>{children}</View>;
  return (
    <HistoryGestureSurface
      ref={surfaceRef}
      gestureEpoch={epochRef.current}
      enabled={!!item}
      onDragRequested={(event) => void handleDragRequested(event.nativeEvent)}
    >
      <HistoryDragSource
        sourceId={item?.id ?? 'clipboard-text'}
        gestureMode={item ? 'drag' : 'disabled'}
        accessibilityHint={item ? t('clipboard.textDragHint') : undefined}
      >
        {children}
      </HistoryDragSource>
    </HistoryGestureSurface>
  );
}

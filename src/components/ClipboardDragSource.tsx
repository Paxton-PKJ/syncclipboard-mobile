import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import {
  HistoryDragSource,
  HistoryGestureSurface,
  type HistoryDragItem,
  type HistoryDragRequest,
  type HistoryGestureSurfaceHandle,
} from 'native-util';
import { useTranslation } from 'react-i18next';
import { useMessageStore } from '@/stores/messageStore';

interface ClipboardDragSourceProps extends ViewProps {
  item: HistoryDragItem | null;
  contentType: 'Text' | 'Image';
  children: React.ReactNode;
}

let nextGestureEpoch = 0;

/** 首页图片和文本共用原生拖拽会话；仅包裹预览，保留卡片按钮和滚动行为。 */
export function ClipboardDragSource({
  item,
  contentType,
  children,
  style,
  ...viewProps
}: ClipboardDragSourceProps) {
  const surfaceRef = useRef<HistoryGestureSurfaceHandle | null>(null);
  const currentItemRef = useRef(item);
  const gestureEpoch = useMemo(() => ++nextGestureEpoch, [item]);
  const mountedRef = useRef(true);
  const { t } = useTranslation();
  const { showMessage } = useMessageStore();
  const failureKey =
    contentType === 'Image' ? 'clipboard.imageDragFailed' : 'clipboard.textDragFailed';
  useLayoutEffect(() => {
    currentItemRef.current = item;
  }, [item]);

  useEffect(() => {
    mountedRef.current = true;
    const surface = surfaceRef.current;
    return () => {
      mountedRef.current = false;
      // 原生 cancelGesture 仅取消准备；已开始的系统拖拽保留接收方的读取窗口。
      void surface?.cancelGesture().catch(() => {});
    };
  }, []);

  const handleDragRequested = async ({ gestureId, sourceId }: HistoryDragRequest) => {
    if (!item || sourceId !== item.id || Platform.OS !== 'android') return;
    const isCurrent = () => mountedRef.current && currentItemRef.current === item;
    try {
      const result = await surfaceRef.current?.startDrag(gestureId, [item]);
      if (!isCurrent() || !result || result.started || result.code === 'CANCELLED') return;
      showMessage(
        t(
          contentType === 'Text' && result.code === 'PAYLOAD_TOO_LARGE'
            ? 'clipboard.textDragTooLarge'
            : failureKey
        ),
        'error'
      );
    } catch {
      if (isCurrent()) showMessage(t(failureKey), 'error');
    }
  };

  if (Platform.OS !== 'android')
    return (
      <View style={style} {...viewProps}>
        {children}
      </View>
    );
  return (
    <HistoryGestureSurface
      ref={surfaceRef}
      style={style}
      gestureEpoch={gestureEpoch}
      enabled={!!item}
      onDragRequested={(event) => void handleDragRequested(event.nativeEvent)}
    >
      <HistoryDragSource
        {...viewProps}
        style={style}
        sourceId={item?.id ?? `clipboard-${contentType.toLowerCase()}`}
        gestureMode={item ? 'drag' : 'disabled'}
        accessibilityHint={
          item
            ? t(contentType === 'Image' ? 'clipboard.imageDragHint' : 'clipboard.textDragHint')
            : undefined
        }
      >
        {children}
      </HistoryDragSource>
    </HistoryGestureSurface>
  );
}

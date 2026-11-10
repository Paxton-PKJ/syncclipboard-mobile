import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { StyleSheet, type ViewProps } from 'react-native';
import {
  DragSource,
  DragGestureSurface,
  type DragItem,
  type DragRequest,
  type DragGestureSurfaceHandle,
} from 'native-util';
import { useTranslation } from 'react-i18next';
import { useMessageStore } from '@/stores/messageStore';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 首页拖拽条目；id 缺失时由 ClipboardDragSource 统一生成兜底 id。 */
export type ClipboardDragItem = DistributiveOmit<DragItem, 'id'> & { id?: string };

interface ClipboardDragSourceProps extends ViewProps {
  item: ClipboardDragItem | null;
  contentType: 'Text' | 'Image';
  children: React.ReactNode;
}

/**
 * 首页图片和文本共用原生拖拽会话；仅包裹预览，保留卡片按钮和滚动行为。
 * 非 Android 平台由 native-util 入口渲染普通 View，startDrag 返回 UNAVAILABLE。
 */
export function ClipboardDragSource({
  item,
  contentType,
  children,
  style,
  ...viewProps
}: ClipboardDragSourceProps) {
  const fallbackId = `clipboard-${contentType.toLowerCase()}`;
  const dragItem = useMemo<DragItem | null>(
    () => (item ? ({ ...item, id: item.id || fallbackId } as DragItem) : null),
    [item, fallbackId]
  );
  const surfaceRef = useRef<DragGestureSurfaceHandle | null>(null);
  const currentItemRef = useRef(dragItem);
  // 条目变化时递增本地 epoch，使原生侧取消旧条目的未完成手势
  const epochRef = useRef({ item: dragItem, epoch: 0 });
  if (epochRef.current.item !== dragItem) {
    epochRef.current = { item: dragItem, epoch: epochRef.current.epoch + 1 };
  }
  const gestureEpoch = epochRef.current.epoch;
  const mountedRef = useRef(true);
  const { t } = useTranslation();
  const showMessage = useMessageStore((state) => state.showMessage);
  const failureKey =
    contentType === 'Image' ? 'clipboard.imageDragFailed' : 'clipboard.textDragFailed';
  useLayoutEffect(() => {
    currentItemRef.current = dragItem;
  }, [dragItem]);

  useEffect(() => {
    mountedRef.current = true;
    const surface = surfaceRef.current;
    return () => {
      mountedRef.current = false;
      // 原生 cancelGesture 仅取消准备；已开始的系统拖拽保留接收方的读取窗口。
      void surface?.cancelGesture().catch(() => {});
    };
  }, []);

  const handleDragRequested = async ({ gestureId, sourceId }: DragRequest) => {
    if (!dragItem || sourceId !== dragItem.id) return;
    const isCurrent = () => mountedRef.current && currentItemRef.current === dragItem;
    try {
      const result = await surfaceRef.current?.startDrag(gestureId, [dragItem]);
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

  return (
    <DragGestureSurface
      ref={surfaceRef}
      style={style}
      gestureEpoch={gestureEpoch}
      enabled={!!dragItem}
      onDragRequested={(event) => void handleDragRequested(event.nativeEvent)}
    >
      <DragSource
        {...viewProps}
        style={styles.fill}
        sourceId={dragItem?.id ?? fallbackId}
        gestureMode={dragItem ? 'drag' : 'disabled'}
        accessibilityHint={
          dragItem
            ? t(contentType === 'Image' ? 'clipboard.imageDragHint' : 'clipboard.textDragHint')
            : undefined
        }
      >
        {children}
      </DragSource>
    </DragGestureSurface>
  );
}

const styles = StyleSheet.create({
  // 外层 surface 持有尺寸样式；内层仅填充，不重复应用 padding/尺寸
  fill: {
    flexGrow: 1,
    alignSelf: 'stretch',
  },
});

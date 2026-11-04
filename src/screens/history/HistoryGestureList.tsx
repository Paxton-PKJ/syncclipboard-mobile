import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { FlashList, type FlashListProps, type FlashListRef } from '@shopify/flash-list';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { HistoryGestureSurface, type HistoryGestureSurfaceHandle } from 'native-util';
import { useHistoryStore } from '@/stores/historyStore';
import { useMessageStore } from '@/stores/messageStore';
import type { HistoryItem } from '@/types/clipboard';
import { HistoryDragSelectionController, historyDragErrorMessage } from './historyDragSelection';

interface HistoryGestureListProps {
  listProps: FlashListProps<HistoryItem>;
  scopeKey: string;
  active: boolean;
  multiSelect: boolean;
  enterMultiSelect(): void;
  onRangeActive(active: boolean): void;
  activeListRef: React.RefObject<FlashListRef<HistoryItem> | null>;
}

/** 稳定的列表级触摸容器，使持续选择不依赖 FlashList 源行存活。 */
export function HistoryGestureList(props: HistoryGestureListProps) {
  const { t } = useTranslation();
  const latest = useRef(props);
  latest.current = props;
  const viewportSize = useRef<{ width: number; height: number } | null>(null);
  const listRef = useRef<FlashListRef<HistoryItem>>(null);
  const surfaceRef = useRef<HistoryGestureSurfaceHandle>(null);
  const [rangeActive, setRangeActive] = useState(false);
  const [gestureEpoch, setGestureEpoch] = useState(0);
  const controllerRef = useRef<HistoryDragSelectionController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new HistoryDragSelectionController({
      getSnapshot: () => useHistoryStore.getState(),
      getVisibleIds: () => (latest.current.listProps.data ?? []).map((item) => item.profileHash),
      getList: () => listRef.current,
      getSurface: () => surfaceRef.current,
      // 原生坐标相对手势容器，视口取容器自身尺寸，避免小窗下屏幕/窗口坐标偏移。
      measureViewport: (callback) => {
        if (viewportSize.current) callback({ x: 0, y: 0, ...viewportSize.current });
      },
      select: (selectedIds) => useHistoryStore.setState({ selectedIds }),
      enterMultiSelect: () => latest.current.enterMultiSelect(),
      onRangeActive: (active) => {
        setRangeActive(active);
        latest.current.onRangeActive(active);
      },
      onError: (code) => {
        const key = historyDragErrorMessage(code);
        if (key) useMessageStore.getState().showMessage(t(key), 'error');
      },
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (id) => cancelAnimationFrame(id),
    });
  }
  const controller = controllerRef.current;
  const cancel = useCallback(() => {
    controller.cancel();
    setGestureEpoch((epoch) => epoch + 1);
  }, [controller]);

  useLayoutEffect(() => {
    cancel();
  }, [cancel, props.scopeKey, props.active]);
  useLayoutEffect(() => {
    if (!props.multiSelect) cancel();
  }, [cancel, props.multiSelect]);
  useFocusEffect(useCallback(() => () => cancel(), [cancel]));
  useLayoutEffect(() => () => controller.cancel(), [controller]);
  useLayoutEffect(() => {
    if (!props.active) return;
    props.activeListRef.current = listRef.current;
    return () => {
      if (props.activeListRef.current === listRef.current) props.activeListRef.current = null;
    };
  }, [props.active, props.activeListRef]);

  return (
    <View
      style={styles.container}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        viewportSize.current = { width, height };
        controller.onViewportChanged();
      }}
    >
      <HistoryGestureSurface
        ref={surfaceRef}
        style={styles.container}
        enabled={Platform.OS === 'android' && props.active}
        gestureEpoch={gestureEpoch}
        onSelectionGesture={(event) => controller.selection(event.nativeEvent)}
        onDragRequested={(event) => {
          void controller.drag(event.nativeEvent);
        }}
      >
        <FlashList
          {...props.listProps}
          ref={listRef}
          scrollEnabled={!rangeActive}
          maintainVisibleContentPosition={{ disabled: true }}
          onScroll={(event) => {
            controller.onScroll();
            props.listProps.onScroll?.(event);
          }}
          scrollEventThrottle={16}
        />
      </HistoryGestureSurface>
    </View>
  );
}

const styles = StyleSheet.create({ container: { flex: 1 } });

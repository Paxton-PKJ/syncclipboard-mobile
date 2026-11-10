import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { Platform, View, type NativeSyntheticEvent, type ViewProps } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

export type DragGestureMode = 'select' | 'drag' | 'disabled';
export type DragItem =
  | { id: string; kind: 'image'; fileUri: string; expectedSize?: number }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'textFile'; fileUri: string; expectedSize?: number };
export type DragErrorCode =
  | 'EMPTY_SELECTION'
  | 'UNSUPPORTED_ITEM'
  | 'ITEM_NOT_FOUND'
  | 'ITEM_NOT_READY'
  | 'INVALID_IMAGE'
  | 'INVALID_TEXT'
  | 'SOURCE_CHANGED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNAVAILABLE'
  | 'START_FAILED'
  | 'CANCELLED'
  | 'BUSY';
export type DragStartResult =
  | { started: true }
  | { started: false; code: DragErrorCode; itemId?: string };
export interface DragGestureSurfaceHandle {
  startDrag(gestureId: number, items: DragItem[]): Promise<DragStartResult>;
  cancelGesture(): Promise<void>;
}
export interface SelectionGesture {
  gestureId: number;
  sourceId: string;
  phase: 'start' | 'move' | 'end' | 'cancel';
  /** Pointer position in dp relative to the surface's own top-left corner. */
  x: number;
  y: number;
}
export interface DragRequest {
  gestureId: number;
  sourceId: string;
}
export interface DragEnd {
  gestureId: number;
  completed: boolean;
}
export interface DragGestureSurfaceProps extends ViewProps {
  gestureEpoch: number;
  enabled?: boolean;
  onSelectionGesture?: (event: NativeSyntheticEvent<SelectionGesture>) => void;
  onDragRequested?: (event: NativeSyntheticEvent<DragRequest>) => void;
  onDragEnded?: (event: NativeSyntheticEvent<DragEnd>) => void;
}
const NativeSurface =
  Platform.OS === 'android'
    ? requireNativeViewManager<
        DragGestureSurfaceProps & React.RefAttributes<DragGestureSurfaceHandle>
      >('NativeUtilModule', 'DragGestureSurfaceView')
    : null;

/**
 * 当前平台是否提供原生拖拽手势 surface。为 false 时调用方应回退到 RN 自身的长按等手势。
 */
export const isNativeDragGestureAvailable = Platform.OS === 'android' && NativeSurface !== null;

/** 列表/卡片级稳定手势容器，持有原生选择与系统拖拽会话；非 Android 渲染普通 View。 */
export const DragGestureSurface = forwardRef<DragGestureSurfaceHandle, DragGestureSurfaceProps>(
  function DragGestureSurface(
    { gestureEpoch, enabled = true, onSelectionGesture, onDragRequested, onDragEnded, ...props },
    ref
  ) {
    const nativeRef = useRef<DragGestureSurfaceHandle | null>(null);
    useImperativeHandle(
      ref,
      () => ({
        startDrag: (gestureId, items): Promise<DragStartResult> =>
          nativeRef.current?.startDrag(gestureId, items) ??
          Promise.resolve({ started: false, code: 'UNAVAILABLE' }),
        cancelGesture: () => nativeRef.current?.cancelGesture() ?? Promise.resolve(),
      }),
      []
    );
    if (Platform.OS !== 'android' || !NativeSurface) return <View {...props} />;
    return (
      <NativeSurface
        {...props}
        ref={nativeRef}
        gestureEpoch={gestureEpoch}
        enabled={enabled}
        onSelectionGesture={onSelectionGesture}
        onDragRequested={onDragRequested}
        onDragEnded={onDragEnded}
      />
    );
  }
);

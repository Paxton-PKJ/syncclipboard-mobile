import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { Platform, View, type NativeSyntheticEvent, type ViewProps } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

export type HistoryGestureMode = 'select' | 'drag' | 'disabled';
export type HistoryDragItem =
  | { id: string; kind: 'image'; fileUri: string; expectedSize?: number }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'textFile'; fileUri: string; expectedSize?: number };
export type HistoryDragErrorCode =
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
export type HistoryDragStartResult =
  | { started: true }
  | { started: false; code: HistoryDragErrorCode; itemId?: string };
export interface HistoryGestureSurfaceHandle {
  startDrag(gestureId: number, items: HistoryDragItem[]): Promise<HistoryDragStartResult>;
  cancelGesture(): Promise<void>;
}
export interface HistorySelectionGesture {
  gestureId: number;
  sourceId: string;
  phase: 'start' | 'move' | 'end' | 'cancel';
  /** Pointer position in dp relative to the surface's own top-left corner. */
  x: number;
  y: number;
}
export interface HistoryDragRequest {
  gestureId: number;
  sourceId: string;
}
export interface HistoryDragEnd {
  gestureId: number;
  completed: boolean;
}
export interface HistoryGestureSurfaceProps extends ViewProps {
  gestureEpoch: number;
  enabled?: boolean;
  onSelectionGesture?: (event: NativeSyntheticEvent<HistorySelectionGesture>) => void;
  onDragRequested?: (event: NativeSyntheticEvent<HistoryDragRequest>) => void;
  onDragEnded?: (event: NativeSyntheticEvent<HistoryDragEnd>) => void;
}
const NativeSurface =
  Platform.OS === 'android'
    ? requireNativeViewManager<
        HistoryGestureSurfaceProps & React.RefAttributes<HistoryGestureSurfaceHandle>
      >('NativeUtilModule', 'HistoryGestureSurfaceView')
    : null;

/** Stable list owner for native selection and system drag sessions. */
export const HistoryGestureSurface = forwardRef<
  HistoryGestureSurfaceHandle,
  HistoryGestureSurfaceProps
>(function HistoryGestureSurface(
  { gestureEpoch, enabled = true, onSelectionGesture, onDragRequested, onDragEnded, ...props },
  ref
) {
  const nativeRef = useRef<HistoryGestureSurfaceHandle | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      startDrag: (gestureId, items): Promise<HistoryDragStartResult> =>
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
});

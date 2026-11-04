import React from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';
import type { HistoryGestureMode } from './HistoryGestureSurface';

export interface HistoryDragSourceProps extends ViewProps {
  sourceId: string;
  gestureMode: HistoryGestureMode;
}
const NativeSource =
  Platform.OS === 'android'
    ? requireNativeViewManager<HistoryDragSourceProps>('NativeUtilModule', 'HistoryDragSourceView')
    : null;

/** Metadata marker; the list surface owns recognition and lifetime. */
export function HistoryDragSource({ sourceId, gestureMode, ...props }: HistoryDragSourceProps) {
  if (Platform.OS !== 'android' || !NativeSource) return <View {...props} />;
  return <NativeSource {...props} sourceId={sourceId} gestureMode={gestureMode} />;
}

import React from 'react';
import { Platform, View, type NativeSyntheticEvent, type ViewProps } from 'react-native';
import type { HistoryDragErrorCode } from './HistoryGestureSurface';
import { requireNativeViewManager } from 'expo-modules-core';

export interface ImageDragSourceProps extends ViewProps {
  fileUri: string;
  expectedSize?: number;
  enabled?: boolean;
  onDragStartFailed?: (event: NativeSyntheticEvent<{ code: HistoryDragErrorCode }>) => void;
}

const NativeImageDragSource =
  Platform.OS === 'android'
    ? requireNativeViewManager<ImageDragSourceProps>('NativeUtilModule')
    : null;

/** Local image drag source; unsupported platforms keep the ordinary preview. */
export function ImageDragSource({
  fileUri,
  expectedSize,
  enabled = true,
  onDragStartFailed,
  ...props
}: ImageDragSourceProps) {
  if (!NativeImageDragSource) return <View {...props} />;
  return (
    <NativeImageDragSource
      {...props}
      fileUri={fileUri}
      expectedSize={expectedSize}
      enabled={enabled}
      onDragStartFailed={onDragStartFailed}
    />
  );
}

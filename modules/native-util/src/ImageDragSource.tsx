import React from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

export interface ImageDragSourceProps extends ViewProps {
  fileUri: string;
  expectedSize?: number;
  onDragStartFailed?: () => void;
}

const NativeImageDragSource =
  Platform.OS === 'android'
    ? requireNativeViewManager<ImageDragSourceProps>('NativeUtilModule')
    : null;

/** Local image drag source; unsupported platforms keep the ordinary preview. */
export function ImageDragSource({
  fileUri,
  expectedSize,
  onDragStartFailed,
  ...props
}: ImageDragSourceProps) {
  if (!NativeImageDragSource) return <View {...props} />;
  return (
    <NativeImageDragSource
      {...props}
      fileUri={fileUri}
      expectedSize={expectedSize}
      onDragStartFailed={onDragStartFailed}
    />
  );
}

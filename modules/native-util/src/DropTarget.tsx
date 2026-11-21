import React from 'react';
import { Platform, View, type NativeSyntheticEvent, type ViewProps } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

export interface DropDragStateEvent {
  active: boolean;
  entered: boolean;
}

export interface IncomingSessionMeta {
  sessionId: string;
  kind: 'text' | 'file' | 'multiple' | 'unsupported_mixed' | 'empty';
  itemCount: number;
  previewText?: string;
}

export interface DropTargetProps extends ViewProps {
  enabled?: boolean;
  onDragStateChange?: (event: NativeSyntheticEvent<DropDragStateEvent>) => void;
  onDropReceived?: (event: NativeSyntheticEvent<IncomingSessionMeta>) => void;
}

const NativeDropTarget =
  Platform.OS === 'android'
    ? requireNativeViewManager<DropTargetProps>('NativeUtilModule', 'DropTargetView')
    : null;

/**
 * 当前平台是否提供原生系统拖放接收容器。
 */
export const isNativeDropTargetAvailable = Platform.OS === 'android' && NativeDropTarget !== null;

/**
 * 原生拖放接收容器；非 Android 平台安全降级为普通 View。
 */
export function DropTarget({
  enabled = true,
  onDragStateChange,
  onDropReceived,
  ...props
}: DropTargetProps) {
  if (Platform.OS !== 'android' || !NativeDropTarget) {
    return <View {...props} />;
  }

  return (
    <NativeDropTarget
      {...props}
      enabled={enabled}
      onDragStateChange={onDragStateChange}
      onDropReceived={onDropReceived}
    />
  );
}

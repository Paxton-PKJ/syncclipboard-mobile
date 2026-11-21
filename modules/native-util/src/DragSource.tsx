import React from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';
import type { DragGestureMode } from './DragGestureSurface';

export interface DragSourceProps extends ViewProps {
  sourceId: string;
  gestureMode: DragGestureMode;
}
const NativeSource =
  Platform.OS === 'android'
    ? requireNativeViewManager<DragSourceProps>('NativeUtilModule', 'DragSourceView')
    : null;

/** 命中元数据标记；识别与会话生命周期由外层 DragGestureSurface 持有。非 Android 渲染普通 View。 */
export function DragSource({ sourceId, gestureMode, ...props }: DragSourceProps) {
  if (Platform.OS !== 'android' || !NativeSource) return <View {...props} />;
  return <NativeSource {...props} sourceId={sourceId} gestureMode={gestureMode} />;
}

/**
 * 拖拽手势屏蔽区：包裹按钮、元信息等区域，使外层 DragGestureSurface 命中测试
 * 落到此处时不启动选择或拖拽，保留子视图自身的点击与长按。
 * 非 Android 平台渲染普通 View。
 */
export function DragExclusionZone(props: ViewProps) {
  return <DragSource {...props} sourceId="" gestureMode="disabled" />;
}

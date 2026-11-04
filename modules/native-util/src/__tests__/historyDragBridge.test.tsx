import React from 'react';
// @ts-expect-error React Native ships this renderer without declarations.
import TestRenderer, { act } from 'react-test-renderer';
import { Platform, View } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';
import { HistoryGestureSurface, type HistoryGestureSurfaceHandle } from '../HistoryGestureSurface';
import { HistoryDragSource } from '../HistoryDragSource';

jest.mock('expo-modules-core', () => ({
  requireNativeViewManager: jest.fn((_module: string, name: string) => name),
}));
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: {
    OS: 'android',
    select: (options: Record<string, unknown>) => options.android ?? options.default,
  },
}));

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: ReturnType<typeof TestRenderer.create>;
const previousPlatform = Platform.OS;
beforeEach(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  Platform.OS = 'android';
});
afterEach(async () => {
  await act(async () => root?.unmount());
  Platform.OS = previousPlatform;
});

it('uses named views and forwards one complete batch and gesture ID to native', async () => {
  const startDrag = jest.fn().mockResolvedValue({ started: true });
  const cancelGesture = jest.fn().mockResolvedValue(undefined);
  const ref = React.createRef<HistoryGestureSurfaceHandle>();
  const items = [{ id: 'text', kind: 'text' as const, text: '全文🙂' }];
  await act(async () => {
    root = TestRenderer.create(
      <HistoryGestureSurface ref={ref} gestureEpoch={3}>
        <HistoryDragSource sourceId="text" gestureMode="select">
          <View />
        </HistoryDragSource>
      </HistoryGestureSurface>,
      { createNodeMock: () => ({ startDrag, cancelGesture }) }
    );
  });
  expect(requireNativeViewManager).toHaveBeenCalledWith(
    'NativeUtilModule',
    'HistoryGestureSurfaceView'
  );
  expect(requireNativeViewManager).toHaveBeenCalledWith(
    'NativeUtilModule',
    'HistoryDragSourceView'
  );
  expect(root.root.findByType('HistoryDragSourceView').props).toMatchObject({
    sourceId: 'text',
    gestureMode: 'select',
  });
  await expect(ref.current?.startDrag(7, items)).resolves.toEqual({ started: true });
  expect(startDrag).toHaveBeenCalledTimes(1);
  expect(startDrag).toHaveBeenCalledWith(7, items);
  await ref.current?.cancelGesture();
  expect(cancelGesture).toHaveBeenCalledTimes(1);
});

it('falls back to ordinary Views and an unavailable result on unsupported platforms', async () => {
  Platform.OS = 'ios';
  const ref = React.createRef<HistoryGestureSurfaceHandle>();
  await act(async () => {
    root = TestRenderer.create(
      <HistoryGestureSurface ref={ref} gestureEpoch={1}>
        <HistoryDragSource sourceId="one" gestureMode="drag">
          <View />
        </HistoryDragSource>
      </HistoryGestureSurface>
    );
  });
  expect(root.root.findAllByType('HistoryGestureSurfaceView')).toHaveLength(0);
  expect(root.root.findAllByType('HistoryDragSourceView')).toHaveLength(0);
  await expect(ref.current?.startDrag(1, [])).resolves.toEqual({
    started: false,
    code: 'UNAVAILABLE',
  });
  await expect(ref.current?.cancelGesture()).resolves.toBeUndefined();
});

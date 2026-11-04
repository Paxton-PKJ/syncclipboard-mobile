import * as mockReact from 'react';
// @ts-expect-error React Native provides the renderer without its type declarations.
import TestRenderer, { act } from 'react-test-renderer';
import { createHistoryItem } from '../types/clipboard';
import { HistoryGestureList } from '../screens/history/HistoryGestureList';
import {
  HistoryDragSelectionController,
  historyDragErrorMessage,
} from '../screens/history/historyDragSelection';
import type { HistoryDragSelectionDeps } from '../screens/history/historyDragSelection';
import type {
  HistoryDragErrorCode,
  HistoryDragItem,
  HistoryDragStartResult,
  HistorySelectionGesture,
} from 'native-util';

jest.mock('native-util', () => ({
  HistoryGestureSurface: mockReact.forwardRef(
    (props: mockReact.PropsWithChildren<Record<string, unknown>>, ref) => {
      mockReact.useImperativeHandle(ref, () => mockSurface);
      return mockReact.createElement('HistoryGestureSurface', props);
    }
  ),
}));
jest.mock('@shopify/flash-list', () => ({
  FlashList: mockReact.forwardRef(
    (props: mockReact.PropsWithChildren<Record<string, unknown>>, ref) => {
      mockReact.useImperativeHandle(ref, () => ({}));
      return mockReact.createElement('FlashList', props);
    }
  ),
}));
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) => mockReact.useEffect(callback, [callback]),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../stores/historyStore', () => ({
  useHistoryStore: {
    getState: () => mockSnapshot,
    setState: (next: { selectedIds: Set<string> }) => Object.assign(mockSnapshot, next),
  },
}));
jest.mock('../stores/messageStore', () => ({
  useMessageStore: { getState: () => ({ showMessage: jest.fn() }) },
}));
const mockSurface = {
  startDrag: jest.fn().mockResolvedValue({ started: true }),
  cancelGesture: jest.fn().mockResolvedValue(undefined),
};
const mockSnapshot = {
  items: [
    createHistoryItem({
      profileHash: 'source',
      type: 'Text',
      text: 'full original',
      hasData: false,
      timestamp: 1,
    }),
  ],
  selectedIds: new Set<string>(),
};

it('wires the stable surface to range selection, disables list scrolling, and keeps selection updates out of its epoch', async () => {
  const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  let root: ReturnType<typeof TestRenderer.create>;
  const enterMultiSelect = jest.fn();
  const props = {
    listProps: { data: mockSnapshot.items, renderItem: () => null },
    scopeKey: 'same-data',
    active: true,
    multiSelect: false,
    enterMultiSelect,
    onRangeActive: jest.fn(),
    activeListRef: { current: null },
  };
  try {
    await act(async () => {
      root = TestRenderer.create(mockReact.createElement(HistoryGestureList, props));
    });
    const surface = () => root.root.findByType('HistoryGestureSurface');
    const epoch = surface().props.gestureEpoch;
    await act(async () =>
      surface().props.onSelectionGesture({
        nativeEvent: {
          gestureId: 100,
          sourceId: 'source',
          phase: 'start',
          absoluteX: 10,
          absoluteY: 10,
        },
      })
    );
    expect(enterMultiSelect).toHaveBeenCalledTimes(1);
    expect([...mockSnapshot.selectedIds]).toEqual(['source']);
    expect(root.root.findByType('FlashList').props.scrollEnabled).toBe(false);
    await act(async () =>
      root.update(mockReact.createElement(HistoryGestureList, { ...props, multiSelect: true }))
    );
    expect(surface().props.gestureEpoch).toBe(epoch);
    expect(mockSurface.startDrag).not.toHaveBeenCalled();
    await act(async () =>
      surface().props.onSelectionGesture({
        nativeEvent: {
          gestureId: 100,
          sourceId: 'source',
          phase: 'end',
          absoluteX: 10,
          absoluteY: 10,
        },
      })
    );
    expect(root.root.findByType('FlashList').props.scrollEnabled).toBe(true);
    await act(async () =>
      surface().props.onDragRequested({ nativeEvent: { gestureId: 101, sourceId: 'source' } })
    );
    expect(mockSurface.startDrag).toHaveBeenCalledWith(101, [
      { id: 'source', kind: 'text', text: 'full original' },
    ]);
    await act(async () =>
      root.update(
        mockReact.createElement(HistoryGestureList, {
          ...props,
          multiSelect: true,
          scopeKey: 'changed-filter',
        })
      )
    );
    expect(surface().props.gestureEpoch).toBeGreaterThan(epoch);
  } finally {
    await act(async () => root?.unmount());
    testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

function fixture() {
  const items = Array.from({ length: 50 }, (_, index) =>
    createHistoryItem({
      profileHash: String(index),
      type: 'Text',
      text: `原文 ${index}\n`,
      hasData: false,
      timestamp: 1,
    })
  );
  let selectedIds = new Set<string>();
  let offset = 0;
  let frameId = 0;
  const frames = new Map<number, (time: number) => void>();
  const surface = {
    startDrag: jest
      .fn<Promise<HistoryDragStartResult>, [number, HistoryDragItem[]]>()
      .mockResolvedValue({ started: true }),
    cancelGesture: jest.fn().mockResolvedValue(undefined),
  };
  const deps: HistoryDragSelectionDeps = {
    getSnapshot: () => ({ items, selectedIds }),
    getVisibleIds: () => items.map((item) => item.profileHash),
    getList: () => ({
      getLayout: (index) => ({ x: 0, y: index * 50, width: 300, height: 50 }),
      getFirstItemOffset: () => 20,
      getAbsoluteLastScrollOffset: () => offset,
      getChildContainerDimensions: () => ({ width: 300, height: 2500 }),
      scrollToOffset: (options) => {
        offset = options.offset;
      },
    }),
    getSurface: () => surface,
    measureViewport: (callback) => callback({ x: 0, y: 100, width: 300, height: 200 }),
    select: (ids) => {
      selectedIds = ids;
    },
    enterMultiSelect: jest.fn(),
    onRangeActive: jest.fn(),
    onError: jest.fn(),
    requestFrame: (callback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
  };
  const controller = new HistoryDragSelectionController(deps);
  const event = (
    phase: HistorySelectionGesture['phase'],
    absoluteY = 150,
    sourceId = '0',
    gestureId = 1
  ) => controller.selection({ phase, absoluteY, absoluteX: 100, sourceId, gestureId });
  return {
    controller,
    deps,
    surface,
    items,
    event,
    frames,
    select: (ids: string[]) => {
      selectedIds = new Set(ids);
    },
    selected: () => [...selectedIds],
    offset: () => offset,
    frame(time: number) {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(time));
    },
  };
}

it('keeps the initial hold in selection after React enters multi-select, then accepts exactly one second-hold drag', async () => {
  const f = fixture();
  f.event('start');
  f.event('move', 270);
  await f.controller.drag({ gestureId: 1, sourceId: '0' });
  expect(f.surface.startDrag).not.toHaveBeenCalled();
  expect(f.selected()).toEqual(['0', '1', '2', '3']);
  f.event('move', 150);
  expect(f.selected()).toEqual(['0', '1', '2', '3']);
  f.event('end');
  await Promise.all([
    f.controller.drag({ gestureId: 2, sourceId: '2' }),
    f.controller.drag({ gestureId: 2, sourceId: '2' }),
  ]);
  expect(f.surface.startDrag).toHaveBeenCalledTimes(1);
  expect(f.surface.startDrag.mock.calls[0][1]).toEqual(
    f.items.slice(0, 4).map((item) => ({ id: item.profileHash, kind: 'text', text: item.text }))
  );
});

it('extends an existing selection from an unselected source without toggling prior rows off', () => {
  const f = fixture();
  f.select(['40', '1']);
  f.event('start', 250, '2');
  f.event('move', 150, '2');
  expect(f.selected()).toEqual(['40', '1', '2', '0']);
});

it('continues selection on every edge-scroll frame with a stationary finger and caps dt to 32ms', () => {
  const f = fixture();
  f.event('start', 300);
  f.frame(0);
  f.frame(1000);
  expect(f.offset()).toBeCloseTo(25.6);
  for (let frame = 1; frame <= 90; frame++) f.frame(1000 + frame * 32);
  expect(f.selected()).toContain('49');
  expect(f.offset()).toBe(2320);
  f.event('end');
  expect(f.frames.size).toBe(0);
  expect(f.deps.onRangeActive).toHaveBeenLastCalledWith(false);
});

it('recomputes actual layout hits after scroll even without a move event', () => {
  const f = fixture();
  f.event('start');
  f.deps.getList()!.scrollToOffset({ offset: 500, animated: false, skipFirstItemOffset: true });
  f.controller.onScroll();
  expect(f.selected()).toContain('10');
});

it('ignores delayed viewport measurement after cancellation and stops all frames without clearing selection', () => {
  const f = fixture();
  let measure: Parameters<HistoryDragSelectionDeps['measureViewport']>[0] | undefined;
  f.deps.measureViewport = (callback) => {
    measure = callback;
  };
  f.event('start');
  f.controller.cancel();
  measure?.({ x: 0, y: 100, width: 300, height: 200 });
  expect(f.frames.size).toBe(0);
  expect(f.selected()).toEqual(['0']);
  expect(f.surface.cancelGesture).toHaveBeenCalled();
});

it('uses one complete store snapshot rather than the current category and preserves selection order', async () => {
  const f = fixture();
  f.deps.getVisibleIds = () => ['0'];
  f.select(['40', '0', '20']);
  const snapshot = jest.spyOn(f.deps, 'getSnapshot');
  await f.controller.drag({ gestureId: 2, sourceId: '0' });
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(f.surface.startDrag.mock.calls[0][1].map((item) => item.id)).toEqual(['40', '0', '20']);
});

it('cancels a source that is no longer selected without attempting a payload', async () => {
  const f = fixture();
  f.select(['1']);
  await f.controller.drag({ gestureId: 2, sourceId: '0' });
  expect(f.surface.startDrag).not.toHaveBeenCalled();
  expect(f.surface.cancelGesture).toHaveBeenCalledTimes(1);
  expect(historyDragErrorMessage('CANCELLED')).toBeUndefined();
});

it('fails the entire group for a stale selected ID and cancels the native request', async () => {
  const f = fixture();
  f.select(['0', 'missing']);
  await f.controller.drag({ gestureId: 2, sourceId: '0' });
  expect(f.surface.startDrag).not.toHaveBeenCalled();
  expect(f.deps.onError).toHaveBeenCalledWith('ITEM_NOT_FOUND');
  expect(f.surface.cancelGesture).toHaveBeenCalled();
});

it.each([
  'UNSUPPORTED_ITEM',
  'ITEM_NOT_FOUND',
  'ITEM_NOT_READY',
  'PAYLOAD_TOO_LARGE',
  'START_FAILED',
  'CANCELLED',
] as const)('handles native business failure %s', async (code) => {
  const f = fixture();
  f.select(['0']);
  f.surface.startDrag.mockResolvedValue({ started: false, code });
  await f.controller.drag({ gestureId: 2, sourceId: '0' });
  expect(f.deps.onError).toHaveBeenCalledWith(code);
  expect(f.surface.cancelGesture).toHaveBeenCalled();
});

it('maps unexpected bridge rejections to a localized failure', async () => {
  const f = fixture();
  f.select(['0']);
  f.surface.startDrag.mockRejectedValue(new Error('bridge'));
  await f.controller.drag({ gestureId: 2, sourceId: '0' });
  expect(f.deps.onError).toHaveBeenCalledWith('START_FAILED');
});

it('discards a pending result after blur/scope cancellation without clearing the selection', async () => {
  const f = fixture();
  f.select(['0']);
  let resolve!: (result: HistoryDragStartResult) => void;
  f.surface.startDrag.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const pending = f.controller.drag({ gestureId: 2, sourceId: '0' });
  f.controller.cancel();
  resolve({ started: false, code: 'START_FAILED' });
  await pending;
  expect(f.deps.onError).not.toHaveBeenCalled();
  expect(f.selected()).toEqual(['0']);
});

it.each([
  ['UNSUPPORTED_ITEM', 'history.dragUnsupported'],
  ['ITEM_NOT_FOUND', 'history.dragMissing'],
  ['SOURCE_CHANGED', 'history.dragNotReady'],
  ['PAYLOAD_TOO_LARGE', 'history.dragTooLarge'],
  ['UNAVAILABLE', 'history.dragFailed'],
] as [HistoryDragErrorCode, string][])('localizes %s', (code, key) => {
  expect(historyDragErrorMessage(code)).toBe(key);
});

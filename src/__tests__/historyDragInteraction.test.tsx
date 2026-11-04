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
      mockReact.useImperativeHandle(ref, () => mockList);
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
const mockList = {
  getLayout: (index: number) => ({ x: 0, y: index * 50, width: 300, height: 50 }),
  getFirstItemOffset: () => 0,
  getAbsoluteLastScrollOffset: () => 0,
  getChildContainerDimensions: () => ({ width: 300, height: 100 }),
  scrollToOffset: jest.fn(),
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
          x: 10,
          y: 10,
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
          x: 10,
          y: 10,
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

it('hit-tests surface-local pointer coordinates against the container size, independent of window offset', async () => {
  const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  const previousItems = mockSnapshot.items;
  mockSnapshot.items = ['A', 'B'].map((profileHash) =>
    createHistoryItem({
      profileHash,
      type: 'Text',
      text: profileHash,
      hasData: false,
      timestamp: 1,
    })
  );
  mockSnapshot.selectedIds = new Set();
  let root: ReturnType<typeof TestRenderer.create>;
  try {
    await act(async () => {
      root = TestRenderer.create(
        mockReact.createElement(HistoryGestureList, {
          listProps: { data: mockSnapshot.items, renderItem: () => null },
          scopeKey: 'local',
          active: true,
          multiSelect: false,
          enterMultiSelect: jest.fn(),
          onRangeActive: jest.fn(),
          activeListRef: { current: null },
        })
      );
    });
    const surface = root!.root.findByType('HistoryGestureSurface');
    // 小窗中容器位于窗口偏移处；该偏移不应参与本地坐标命中。
    await act(async () =>
      root.root
        .find(
          (node: { props: { onLayout?: unknown } }) => typeof node.props.onLayout === 'function'
        )
        .props.onLayout({
          nativeEvent: { layout: { x: 0, y: 300, width: 300, height: 100 } },
        })
    );
    const gesture = (phase: HistorySelectionGesture['phase'], y: number) =>
      act(async () =>
        surface.props.onSelectionGesture({
          nativeEvent: { gestureId: 200, sourceId: 'A', phase, x: 100, y },
        })
      );
    await gesture('start', 25);
    await gesture('move', 75);
    expect([...mockSnapshot.selectedIds]).toEqual(['A', 'B']);
    await gesture('move', 25);
    expect([...mockSnapshot.selectedIds]).toEqual(['A']);
    await gesture('end', 25);
  } finally {
    await act(async () => root?.unmount());
    mockSnapshot.items = previousItems;
    mockSnapshot.selectedIds = new Set();
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
  const event = (phase: HistorySelectionGesture['phase'], y = 150, sourceId = '0', gestureId = 1) =>
    controller.selection({ phase, y, x: 100, sourceId, gestureId });
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
  expect(f.selected()).toEqual(['0']);
  f.event('move', 270);
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
  expect(f.selected()).toEqual(['40', '1', '0', '2']);
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

/** Native observations deliberately do not synchronously follow scroll commands. */
function delayedScrollFixture() {
  const heights = [80, 170, 110, 240, 90, 360];
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
  const layouts = heights.map((height, index) => ({
    x: 0,
    y: heights.slice(0, index).reduce((sum, value) => sum + value, 0),
    width: 300,
    height,
  }));
  const baseline = new Set(['hidden', 'E']);
  let selectedIds = baseline;
  let observed = 0;
  let contentHeight = heights.reduce((sum, value) => sum + value, 0);
  const viewport = { x: 0, y: 100, width: 300, height: 300 };
  let frameId = 0;
  const frames = new Map<number, (time: number) => void>();
  const requests: number[] = [];
  const controller = new HistoryDragSelectionController({
    getSnapshot: () => ({ items: [], selectedIds }),
    getVisibleIds: () => ids,
    getList: () => ({
      getLayout: (index) => layouts[index],
      getFirstItemOffset: () => 0,
      getAbsoluteLastScrollOffset: () => observed,
      getChildContainerDimensions: () => ({ width: 300, height: contentHeight }),
      scrollToOffset: ({ offset }) => requests.push(offset),
    }),
    getSurface: () => null,
    measureViewport: (callback) => callback({ ...viewport }),
    select: (next) => {
      selectedIds = next;
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
  });
  return {
    controller,
    baseline,
    viewport,
    requests,
    frames,
    selected: () => [...selectedIds],
    contentHeight: (height: number) => {
      contentHeight = height;
    },
    event: (phase: HistorySelectionGesture['phase'], y = 399, sourceId = 'A', gestureId = 1) =>
      controller.selection({ phase, y, x: 100, sourceId, gestureId }),
    report: (offset: number) => {
      observed = offset;
      controller.onScroll();
    },
    frame: (time: number) => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(time));
    },
  };
}

it('keeps bottom-edge commands monotonic with variable heights, alternating dt and delayed duplicate/old native offsets', () => {
  const f = delayedScrollFixture();
  f.event('start');
  [0, 16, 48, 64].forEach(f.frame);
  f.report(f.requests[0]);
  f.controller.onScroll();
  [96, 112].forEach(f.frame);
  f.report(f.requests[1]);
  f.report(0);
  [144, 160].forEach(f.frame);
  expect(f.requests.length).toBeGreaterThan(2);
  expect(f.requests.every((offset, index) => index === 0 || offset > f.requests[index - 1])).toBe(
    true
  );
  // A command is not evidence that native has reached a future row.
  expect(f.selected()).toEqual(['hidden', 'E', 'A', 'B', 'C']);
  f.report(400);
  expect(f.selected()).toEqual(['hidden', 'E', 'A', 'B', 'C', 'D', 'F']);
});

it('shrinks a reversed range, preserves a cloned baseline and replaces the range when crossing the anchor', () => {
  const f = delayedScrollFixture();
  f.event('start', 200, 'B');
  f.baseline.add('mutated-after-start');
  f.event('move', 399, 'B');
  f.report(100);
  expect(f.selected()).toEqual(['hidden', 'E', 'B', 'C', 'D']);
  f.report(0);
  f.event('move', 200, 'B');
  expect(f.selected()).toEqual(['hidden', 'E', 'B']);
  f.event('move', 120, 'B');
  expect(f.selected()).toEqual(['hidden', 'E', 'A', 'B']);
  f.event('move', 370, 'B');
  expect(f.selected()).toEqual(['hidden', 'E', 'B', 'C']);
});

it('owns upward scroll targets despite old feedback and reverses direction from observed native position', () => {
  const f = delayedScrollFixture();
  f.report(400);
  f.event('start', 101, 'D');
  [0, 16, 48, 64].forEach(f.frame);
  f.report(390);
  [96, 112].forEach(f.frame);
  expect(f.requests.every((offset, index) => index === 0 || offset < f.requests[index - 1])).toBe(
    true
  );
  f.event('move', 399, 'D');
  f.frame(128);
  expect(f.requests.at(-1)).toBeGreaterThan(390);
  f.report(380);
  f.frame(160);
  expect(f.requests.at(-1)).toBeGreaterThan(f.requests.at(-2)!);
});

it('clamps content boundaries, avoids duplicate requests, and restarts at native position after leaving the edge', () => {
  const f = delayedScrollFixture();
  f.event('start');
  for (let time = 0; time <= 2000; time += 32) f.frame(time);
  expect(f.requests.at(-1)).toBe(750);
  expect(new Set(f.requests).size).toBe(f.requests.length);
  f.contentHeight(500);
  f.frame(2032);
  expect(f.requests.at(-1)).toBe(200);
  f.report(150);
  f.event('move', 250);
  f.frame(2064);
  const count = f.requests.length;
  f.frame(2096);
  expect(f.requests).toHaveLength(count);
  f.event('move', 399);
  f.frame(2128);
  expect(f.requests.at(-1)).toBeCloseTo(175.0666667);
  f.event('move', 101);
  for (let time = 2160; time <= 2480; time += 32) f.frame(time);
  expect(f.requests.at(-1)).toBe(0);
  expect(f.requests.every((offset) => offset >= 0 && offset <= 750)).toBe(true);
});

it('ignores a queued old RAF after UP, including after another range starts', () => {
  const f = delayedScrollFixture();
  f.event('start');
  const oldFrame = [...f.frames.values()][0];
  f.event('end');
  oldFrame(16);
  expect(f.requests).toEqual([]);
  expect(f.frames.size).toBe(0);
  f.event('start', 399, 'A', 2);
  const nextFrames = [...f.frames.keys()];
  oldFrame(32);
  expect([...f.frames.keys()]).toEqual(nextFrames);
  expect(f.requests).toEqual([]);
});

it('remeasures a resized viewport and clamps owned targets to its new content extent', () => {
  const f = delayedScrollFixture();
  f.event('start', 1000);
  for (let time = 0; time <= 1000; time += 32) f.frame(time);
  expect(f.requests.at(-1)).toBe(750);
  f.viewport.height = 400;
  f.controller.onViewportChanged();
  f.frame(1032);
  expect(f.requests.at(-1)).toBe(650);
  f.frame(1064);
  expect(f.requests.filter((offset) => offset === 650)).toHaveLength(1);
  f.report(300);
  f.contentHeight(200);
  f.frame(1096);
  expect(f.requests.at(-1)).toBe(0);
});

it('catches up to an observed position ahead of its target while continuing in the same direction', () => {
  const f = delayedScrollFixture();
  f.event('start');
  [0, 16].forEach(f.frame);
  f.report(200);
  f.frame(48);
  expect(f.requests.at(-1)).toBeGreaterThan(200);
  f.event('move', 101);
  f.frame(64);
  f.report(100);
  f.frame(96);
  expect(f.requests.at(-1)).toBeLessThan(100);
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

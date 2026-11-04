import { createHistoryItem } from '../types/clipboard';
import {
  buildHistoryDragItems,
  extendRangeSelection,
  findHistoryDragIndex,
  historyEdgeVelocity,
} from '../screens/history/historyDragSelection';

const item = (id: string, overrides = {}) =>
  createHistoryItem({
    profileHash: id,
    type: 'Text',
    text: `全文 ${id}\n`,
    hasData: false,
    timestamp: 1,
    ...overrides,
  });

it('unions every crossed row and never removes selections on reversal', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const expanded = extendRangeSelection(new Set(['outside']), ids, 1, 3);
  expect([...expanded]).toEqual(['outside', 'b', 'c', 'd']);
  expect([...extendRangeSelection(expanded, ids, 1, 0)]).toEqual(['outside', 'b', 'c', 'd', 'a']);
  expect([...extendRangeSelection(expanded, ids, -1, 2)]).toEqual([...expanded]);
});

it('maps all IDs in selection insertion order, including items outside the visible category', () => {
  expect(
    buildHistoryDragItems(
      [
        item('text'),
        item('image', { type: 'Image', hasData: true, fileUri: 'file:///image', size: 42 }),
      ],
      new Set(['image', 'text'])
    )
  ).toEqual([
    { id: 'image', kind: 'image', fileUri: 'file:///image', expectedSize: 42 },
    { id: 'text', kind: 'text', text: '全文 text\n' },
  ]);
});

it('passes a complete text file reference and never sends its preview as text', () => {
  expect(
    buildHistoryDragItems(
      [item('a', { hasData: true, text: 'preview', fileUri: 'file:///full.txt', size: 5000 })],
      new Set(['a'])
    )
  ).toEqual([{ id: 'a', kind: 'textFile', fileUri: 'file:///full.txt', expectedSize: 5000 }]);
});

it.each([
  ['missing', [], 'ITEM_NOT_FOUND'],
  ['deleted', [item('a', { isDeleted: true })], 'ITEM_NOT_FOUND'],
  ['File', [item('a', { type: 'File' })], 'UNSUPPORTED_ITEM'],
  ['Group', [item('a', { type: 'Group' })], 'UNSUPPORTED_ITEM'],
  ['undownloaded text', [item('a', { hasData: true })], 'ITEM_NOT_READY'],
  ['undownloaded image', [item('a', { type: 'Image', hasData: true })], 'ITEM_NOT_READY'],
] as const)('fails the entire group for %s', (_label, badItems, code) => {
  expect(() => buildHistoryDragItems([item('good'), ...badItems], new Set(['good', 'a']))).toThrow(
    expect.objectContaining({ code, itemId: 'a' })
  );
});

it('rejects an empty selection', () => {
  expect(() => buildHistoryDragItems([], new Set())).toThrow(
    expect.objectContaining({ code: 'EMPTY_SELECTION' })
  );
});

it('uses actual variable layouts, absolute scroll offset and first-item padding in window dp', () => {
  const layouts = [
    { x: 0, y: 0, width: 300, height: 50 },
    { x: 0, y: 50, width: 300, height: 120 },
  ];
  const viewport = { x: 10, y: 200, width: 300, height: 400 };
  expect(findHistoryDragIndex(30, 225, viewport, 60, 20, 2, (i) => layouts[i])).toBe(1);
  expect(findHistoryDragIndex(0, 225, viewport, 60, 20, 2, (i) => layouts[i])).toBeUndefined();
  expect(findHistoryDragIndex(30, 225, viewport, 60, 20, 2, () => undefined)).toBeUndefined();
});

it('ramps edge scrolling linearly inside 48 dp and caps velocity at 800 dp/s', () => {
  expect(historyEdgeVelocity(200, 200, 400)).toBe(-800);
  expect(historyEdgeVelocity(224, 200, 400)).toBe(-400);
  expect(historyEdgeVelocity(248, 200, 400)).toBe(0);
  expect(historyEdgeVelocity(576, 200, 400)).toBe(400);
  expect(historyEdgeVelocity(900, 200, 400)).toBe(800);
});

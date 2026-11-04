import React from 'react';
// @ts-expect-error React Native provides the renderer without its type declarations.
import TestRenderer, { act } from 'react-test-renderer';
import { Image, Platform, Text } from 'react-native';
import { CurrentClipboardCard } from '../components/CurrentClipboardCard';
import type { ClipboardContent } from '../types/clipboard';

jest.mock('native-util', () => {
  const React = jest.requireActual('react');
  return {
    ImageDragSource: 'ImageDragSource',
    HistoryDragSource: 'HistoryDragSource',
    HistoryGestureSurface: React.forwardRef((props: object, ref: unknown) => {
      React.useImperativeHandle(ref, () => ({
        startDrag: mockStartDrag,
        cancelGesture: mockCancelGesture,
      }));
      return React.createElement('HistoryGestureSurface', props);
    }),
  };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../hooks/useTheme', () => ({ useTheme: () => ({ theme: { colors: {} } }) }));
jest.mock('../stores', () => ({ useSettingsStore: () => ({ config: {} }) }));
jest.mock('../stores/messageStore', () => ({
  useMessageStore: () => ({ showMessage: mockShowMessage }),
}));
jest.mock('../utils/fileActions', () => ({}));
jest.mock('../utils/clipboard/clipboardContentUtils', () => ({}));
jest.mock('../utils/index', () => ({
  isTextInvalid: () => false,
  formatSizeWithType: () => '',
}));
jest.mock('../components/ClipboardTypeIcon', () => ({ ClipboardTypeIcon: 'ClipboardTypeIcon' }));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('react-native/Libraries/Image/Image', () => ({ __esModule: true, default: 'Image' }));
jest.mock('react-native/Libraries/Components/Touchable/TouchableOpacity', () => ({
  __esModule: true,
  default: 'TouchableOpacity',
}));

const mockShowMessage = jest.fn();
const mockStartDrag = jest.fn();
const mockCancelGesture = jest.fn();
const image: ClipboardContent = {
  type: 'Image',
  text: '',
  hasData: true,
  fileUri: 'file:///cache/image.png',
  fileSize: 1000,
  fileName: 'image.png',
};
const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousAct: boolean | undefined;
let previousPlatform: typeof Platform.OS;
let root: ReturnType<typeof TestRenderer.create>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockStartDrag.mockResolvedValue({ started: true });
  mockCancelGesture.mockResolvedValue(undefined);
  previousPlatform = Platform.OS;
  Platform.OS = 'android';
  previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  Platform.OS = previousPlatform;
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
  jest.useRealTimers();
});

function card(content: ClipboardContent, remote = true, acting = false) {
  return (
    <CurrentClipboardCard
      clipboard={content}
      isRemote={remote}
      acting={acting}
      onCopy={jest.fn()}
    />
  );
}

async function render(content: ClipboardContent, remote = true, acting = false) {
  await act(async () => {
    root = TestRenderer.create(card(content, remote, acting));
  });
}

function sources() {
  return root.root.findAllByType('ImageDragSource');
}

async function loadImage() {
  await act(async () => root.root.findByType(Image).props.onLoad());
}

it('keeps a loaded local image draggable while upload is active', async () => {
  await render(image, false, true);
  await loadImage();
  expect(sources()).toHaveLength(1);
  expect(sources()[0].props.fileUri).toBe(image.fileUri);
});

async function requestTextDrag() {
  const surface = root.root.findByType('HistoryGestureSurface');
  const source = root.root.findByType('HistoryDragSource');
  await act(async () =>
    surface.props.onDragRequested({
      nativeEvent: { gestureId: 7, sourceId: source.props.sourceId },
    })
  );
}

it('exposes complete ordinary local text to a drag source', async () => {
  const text = `local text 漢字 🚀 https://example.test ${'full text '.repeat(100)}complete-tail`;
  await render({ type: 'Text', text, hasData: false }, false);
  await requestTextDrag();
  expect(mockStartDrag).toHaveBeenCalledWith(7, [{ id: expect.any(String), kind: 'text', text }]);
});

it('exposes full file-backed local text rather than its preview to a drag source', async () => {
  await render(
    {
      type: 'Text',
      text: 'truncated preview',
      hasData: true,
      fileUri: 'file:///cache/full.txt',
      fileName: 'full.txt',
    },
    false
  );
  await requestTextDrag();
  expect(mockStartDrag).toHaveBeenCalledWith(7, [
    { id: expect.any(String), kind: 'textFile', fileUri: 'file:///cache/full.txt' },
  ]);
});

it('accepts an absolute file:/ image URI', async () => {
  await render({ ...image, fileUri: 'file:/cache/image.png' }, false);
  await loadImage();
  expect(sources()).toHaveLength(1);
});

it.each([false, true])('drags complete remote text (file-backed=%s)', async (hasData) => {
  await render({
    type: 'Text',
    text: 'original text https://example.test tail',
    hasData,
    fileUri: hasData ? 'file:/cache/full.txt' : undefined,
  });
  await requestTextDrag();
  expect(mockStartDrag).toHaveBeenCalledWith(7, [
    hasData
      ? { id: expect.any(String), kind: 'textFile', fileUri: 'file:/cache/full.txt' }
      : { id: expect.any(String), kind: 'text', text: 'original text https://example.test tail' },
  ]);
});

it('keeps local text and its gesture owner stable when uploading starts', async () => {
  const content: ClipboardContent = { type: 'Text', text: 'complete local text', hasData: false };
  await render(content, false);
  const surface = root.root.findByType('HistoryGestureSurface');
  const epoch = surface.props.gestureEpoch;
  await act(async () => root.update(card(content, false, true)));
  expect(root.root.findByType('HistoryGestureSurface')).toBe(surface);
  expect(surface.props.gestureEpoch).toBe(epoch);
  expect(mockCancelGesture).not.toHaveBeenCalled();
  await requestTextDrag();
  expect(mockStartDrag).toHaveBeenCalledTimes(1);
});

it('keeps the loaded local image source mounted when upload begins', async () => {
  await render(image, false);
  await loadImage();
  const source = sources()[0];
  await act(async () => root.update(card(image, false, true)));
  expect(sources()[0]).toBe(source);
});

it.each([
  ['missing complete text file', { hasData: true }, false, false],
  ['network text file', { hasData: true, fileUri: 'https://example.test/full.txt' }, false, false],
  ['content text file', { hasData: true, fileUri: 'content://provider/full.txt' }, false, false],
  ['file authority', { hasData: true, fileUri: 'file://host/full.txt' }, false, false],
  ['active remote download', { hasData: true, fileUri: 'file:///cache/full.txt' }, true, true],
  ['active remote inline update', { hasData: false }, true, true],
] as const)('does not drag a preview for %s', async (_label, extra, remote, acting) => {
  await render({ type: 'Text', text: 'only a preview', ...extra }, remote, acting);
  await requestTextDrag();
  expect(mockStartDrag).not.toHaveBeenCalled();
  expect(root.root.findByType('HistoryDragSource').props.gestureMode).toBe('disabled');
});

it('keeps iOS text selectable without a native drag surface', async () => {
  Platform.OS = 'ios';
  await render({ type: 'Text', text: 'selectable text', hasData: false }, false);
  expect(root.root.findAllByType('HistoryGestureSurface')).toHaveLength(0);
  expect(
    root.root
      .findAllByType(Text)
      .some((node: { props: { selectable?: boolean } }) => node.props.selectable)
  ).toBe(true);
});

it.each([
  ['CANCELLED', undefined],
  ['PAYLOAD_TOO_LARGE', 'clipboard.textDragTooLarge'],
  ['START_FAILED', 'clipboard.textDragFailed'],
] as const)('handles native %s without exposing its code', async (code, message) => {
  mockStartDrag.mockResolvedValue({ started: false, code });
  await render({ type: 'Text', text: 'complete text', hasData: false }, false);
  await requestTextDrag();
  if (message) expect(mockShowMessage).toHaveBeenCalledWith(message, 'error');
  else expect(mockShowMessage).not.toHaveBeenCalled();
});

it.each(['change', 'unmount'] as const)(
  'cancels preparation and suppresses old async failures on %s',
  async (action) => {
    let rejectPreparation: (error: Error) => void = () => {};
    mockStartDrag.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPreparation = reject;
        })
    );
    await render({ type: 'Text', text: 'old complete text', hasData: false }, false);
    const epoch = root.root.findByType('HistoryGestureSurface').props.gestureEpoch;
    await requestTextDrag();
    await act(async () => {
      if (action === 'change')
        root.update(card({ type: 'Text', text: 'new text', hasData: false }, false));
      else root.unmount();
    });
    expect(mockCancelGesture).toHaveBeenCalled();
    if (action === 'change')
      expect(root.root.findByType('HistoryGestureSurface').props.gestureEpoch).toBeGreaterThan(
        epoch
      );
    await act(async () => rejectPreparation(new Error('old native failure')));
    expect(mockShowMessage).not.toHaveBeenCalled();
  }
);

it('invalidates image readiness when the clipboard changes and ignores an old failure', async () => {
  await render(image, false);
  await loadImage();
  const oldFailure = sources()[0].props.onDragStartFailed;
  await act(async () => root.update(card({ ...image, fileUri: 'file:///cache/new.png' }, false)));
  expect(sources()).toHaveLength(0);
  await act(async () => oldFailure());
  expect(mockShowMessage).not.toHaveBeenCalled();
  await loadImage();
  expect(sources()).toHaveLength(1);
});

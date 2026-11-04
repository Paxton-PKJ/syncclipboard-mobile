import React from 'react';
// @ts-expect-error React Native provides the renderer without its type declarations.
import TestRenderer, { act } from 'react-test-renderer';
import { Platform, Text } from 'react-native';
import { File } from 'expo-file-system';
import * as ClipboardProxy from '../utils/clipboardProxy';
import { historyStorage } from '../storage/HistoryStorage';
import { getHistoryFileUri } from '../utils/fileStorage';
import { LocalClipboard } from '../services/clipboard/LocalClipboard';
import { CurrentClipboardCard } from '../components/CurrentClipboardCard';
import { createHistoryItem } from '../types/clipboard';

jest.mock('../utils/clipboardProxy', () => ({ getStringAsync: jest.fn() }));
jest.mock('../utils/hash', () => ({ calculateTextHash: jest.fn(async () => 'text-hash') }));
jest.mock('../storage/HistoryStorage', () => ({
  historyStorage: { getItemByLocalHash: jest.fn() },
}));
jest.mock('../utils/fileStorage', () => ({
  getHistoryFileUri: jest.fn(),
  prepareTempFilePath: (name: string) => `file:///cache/${name}`,
}));
jest.mock('../services/StartupTiming', () => ({
  measureStartup: (_label: string, operation: () => unknown) => operation(),
}));
jest.mock('../i18n', () => ({}));
jest.mock('native-util', () => {
  const React = jest.requireActual('react');
  return {
    HistoryDragSource: 'HistoryDragSource',
    HistoryGestureSurface: React.forwardRef((props: object, ref: unknown) => {
      React.useImperativeHandle(ref, () => ({
        startDrag: mockStartDrag,
        cancelGesture: jest.fn(async () => undefined),
      }));
      return React.createElement('HistoryGestureSurface', props);
    }),
  };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../hooks/useTheme', () => ({ useTheme: () => ({ theme: { colors: {} } }) }));
jest.mock('../stores', () => ({ useSettingsStore: () => ({ config: {} }) }));
jest.mock('../stores/messageStore', () => ({
  useMessageStore: () => ({ showMessage: jest.fn() }),
}));
jest.mock('../utils/fileActions', () => ({}));
jest.mock('../utils/clipboard/clipboardContentUtils', () => ({}));
jest.mock('../utils/index', () => jest.requireActual('../utils/textUtils'));
jest.mock('../components/ClipboardTypeIcon', () => ({ ClipboardTypeIcon: 'ClipboardTypeIcon' }));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('react-native/Libraries/Components/Touchable/TouchableOpacity', () => ({
  __esModule: true,
  default: 'TouchableOpacity',
}));

const mockStartDrag = jest.fn();
const files = new Map<string, Uint8Array>();
const writes = jest.fn();
const encoder = new TextEncoder();
const unicodeText = `${'完整文本🚀é'.repeat(220)}complete-tail`;
const historyUri = 'file:///history/text-hash/full.txt';
const tempUri = 'file:///cache/text-hash.txt';
const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousAct: boolean | undefined;
let previousPlatform: typeof Platform.OS;
let root: ReturnType<typeof TestRenderer.create> | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  files.clear();
  jest.mocked(historyStorage.getItemByLocalHash).mockResolvedValue(null);
  jest.mocked(getHistoryFileUri).mockResolvedValue(historyUri);
  jest.mocked(ClipboardProxy.getStringAsync).mockResolvedValue(unicodeText);
  mockStartDrag.mockResolvedValue({ started: true });
  (File as unknown as jest.Mock).mockImplementation((uri: string) => ({
    uri,
    get exists() {
      return files.has(uri);
    },
    get size() {
      return files.get(uri)?.byteLength ?? 0;
    },
    write: (bytes: Uint8Array) => {
      writes(uri, bytes);
      files.set(uri, new Uint8Array(bytes));
    },
    text: async () => new TextDecoder().decode(files.get(uri)),
  }));
  previousPlatform = Platform.OS;
  Platform.OS = 'android';
  previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  Platform.OS = previousPlatform;
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
  jest.useRealTimers();
});

function useHistoryFile(bytes: Uint8Array) {
  files.set(historyUri, bytes);
  jest.mocked(historyStorage.getItemByLocalHash).mockResolvedValue(
    createHistoryItem({
      type: 'Text',
      text: 'old preview...',
      profileHash: 'text-hash',
      hasData: true,
      dataName: 'full.txt',
      size: unicodeText.length,
      timestamp: 1,
    })
  );
}

it.each([
  ['multibyte Unicode and emoji', unicodeText],
  ['ASCII', 'a'.repeat(1100)],
])('writes complete %s text with its actual UTF-8 byte size', async (_label, text) => {
  jest.mocked(ClipboardProxy.getStringAsync).mockResolvedValue(text);
  const content = await new LocalClipboard().getClipboardContent();
  expect(content).toMatchObject({ type: 'Text', hasData: true, fileUri: tempUri });
  expect(files.get(content!.fileUri!)).toEqual(encoder.encode(text));
  expect(content!.fileSize).toBe(files.get(content!.fileUri!)!.byteLength);
  if (text === unicodeText) expect(content!.fileSize).not.toBe(text.length);
  expect(content).toHaveProperty('textLength', text.length);
});

it('uses the current full text byte size when a history record has legacy character metadata', async () => {
  useHistoryFile(encoder.encode(unicodeText));
  const content = await new LocalClipboard().getClipboardContent();
  expect(content).toMatchObject({ hasData: true, fileUri: historyUri });
  expect(content!.fileSize).toBe(files.get(historyUri)!.byteLength);
  expect(content!.fileSize).not.toBe(unicodeText.length);
  expect(content).toHaveProperty('textLength', unicodeText.length);
  expect(writes).not.toHaveBeenCalled();
});

it('reuses a complete temp file without rewriting it', async () => {
  files.set(tempUri, encoder.encode(unicodeText));
  const content = await new LocalClipboard().getClipboardContent();
  expect(content).toMatchObject({
    hasData: true,
    fileUri: tempUri,
    fileSize: encoder.encode(unicodeText).byteLength,
    textLength: unicodeText.length,
  });
  expect(writes).not.toHaveBeenCalled();
});

it.each(['history', 'temp'] as const)(
  'replaces a truncated %s cache with complete text',
  async (cache) => {
    const incomplete = encoder.encode(unicodeText.substring(0, 200));
    if (cache === 'history') useHistoryFile(incomplete);
    else files.set(tempUri, incomplete);
    const content = await new LocalClipboard().getClipboardContent();
    expect(content).toMatchObject({ hasData: true, fileUri: tempUri });
    expect(files.get(tempUri)).toEqual(encoder.encode(unicodeText));
    expect(content!.fileSize).toBe(files.get(tempUri)!.byteLength);
  }
);

it.each(['history', 'temp'] as const)(
  'rejects same-size incorrect %s cache text',
  async (cache) => {
    const incorrect = encoder.encode(unicodeText.replace('完整', '错误'));
    expect(incorrect.byteLength).toBe(encoder.encode(unicodeText).byteLength);
    if (cache === 'history') useHistoryFile(incorrect);
    else files.set(tempUri, incorrect);
    const content = await new LocalClipboard().getClipboardContent();
    expect(content).toMatchObject({ hasData: true, fileUri: tempUri });
    expect(files.get(tempUri)).toEqual(encoder.encode(unicodeText));
  }
);

it('keeps short text byte size separate from its character count', async () => {
  const text = '短文本🚀';
  jest.mocked(ClipboardProxy.getStringAsync).mockResolvedValue(text);
  const content = await new LocalClipboard().getClipboardContent();
  expect(content).toMatchObject({
    hasData: false,
    text,
    fileSize: encoder.encode(text).byteLength,
  });
  expect(content).toHaveProperty('textLength', text.length);
});

it('ignores legacy size metadata for an inline history match', async () => {
  const text = '短文本🚀';
  jest.mocked(ClipboardProxy.getStringAsync).mockResolvedValue(text);
  jest.mocked(historyStorage.getItemByLocalHash).mockResolvedValue(
    createHistoryItem({
      type: 'Text',
      text,
      profileHash: 'text-hash',
      hasData: false,
      size: text.length,
      timestamp: 1,
    })
  );
  const content = await new LocalClipboard().getClipboardContent();
  expect(content).toMatchObject({
    hasData: false,
    text,
    fileSize: encoder.encode(text).byteLength,
    textLength: text.length,
  });
});

it('passes actual producer bytes to Home native textFile drag and displays the full character count', async () => {
  const content = await new LocalClipboard().getClipboardContent();
  await act(async () => {
    root = TestRenderer.create(<CurrentClipboardCard clipboard={content} onCopy={jest.fn()} />);
  });
  const surface = root!.root.findByType('HistoryGestureSurface');
  const source = root!.root.findByType('HistoryDragSource');
  await act(async () =>
    surface.props.onDragRequested({
      nativeEvent: { gestureId: 7, sourceId: source.props.sourceId },
    })
  );
  expect(mockStartDrag).toHaveBeenCalledWith(7, [
    {
      id: expect.any(String),
      kind: 'textFile',
      fileUri: tempUri,
      expectedSize: files.get(tempUri)!.byteLength,
    },
  ]);
  expect(
    root!.root
      .findAllByType(Text)
      .some(
        (node: { props: { children: unknown } }) =>
          node.props.children === unicodeText.length.toLocaleString('zh-CN')
      )
  ).toBe(true);
});

it('shows bytes for a remote preview whose full character count is unknown', async () => {
  await act(async () => {
    root = TestRenderer.create(
      <CurrentClipboardCard
        clipboard={{ type: 'Text', text: 'preview...', hasData: true, fileSize: 4096 }}
        isRemote
        onCopy={jest.fn()}
      />
    );
  });
  expect(
    root!.root
      .findAllByType(Text)
      .some((node: { props: { children: unknown } }) => node.props.children === '4.0 KB')
  ).toBe(true);
});

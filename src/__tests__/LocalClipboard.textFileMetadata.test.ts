import { File } from 'expo-file-system';
import * as ClipboardProxy from '../utils/clipboardProxy';
import { historyStorage } from '../storage/HistoryStorage';
import { getHistoryFileUri } from '../utils/fileStorage';
import { LocalClipboard } from '../services/clipboard/LocalClipboard';
import { createHistoryItem } from '../types/clipboard';
import {
  clipboardContentToItem,
  contentToProfileDto,
  historyItemToContent,
  historyItemToDto,
  profileDtoToContent,
} from '../utils/clipboard/convert';

jest.mock('../utils/clipboardProxy', () => ({
  hasStringAsync: jest.fn(async () => true),
  getStringAsync: jest.fn(),
}));
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
jest.mock('native-util', () => ({}));
jest.mock('../utils/index', () => jest.requireActual('../utils/textUtils'));

// 刚超过 1000 字符的存储阈值；一个多字节前缀足以区分字符数与 UTF-8 字节数。
const unicodeText = `完整文本🚀é${'a'.repeat(990)}TAIL`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const unicodeBytes = encoder.encode(unicodeText);
const files = new Map<string, Uint8Array>();
const writes = jest.fn();
const reads = jest.fn(async (uri: string) => decoder.decode(files.get(uri)));
const historyUri = 'file:///history/text-hash/full.txt';
const tempUri = 'file:///cache/text-hash.txt';

beforeEach(() => {
  jest.clearAllMocks();
  files.clear();
  jest.mocked(historyStorage.getItemByLocalHash).mockResolvedValue(null);
  jest.mocked(getHistoryFileUri).mockResolvedValue(historyUri);
  jest.mocked(ClipboardProxy.getStringAsync).mockResolvedValue(unicodeText);
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
    text: () => reads(uri),
  }));
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
  ['ASCII', 'a'.repeat(1001)],
])('writes complete %s text with its actual UTF-8 byte size', async (_label, text) => {
  jest.mocked(ClipboardProxy.getStringAsync).mockResolvedValue(text);
  const content = await new LocalClipboard().getClipboardContent();
  expect(content).toMatchObject({
    type: 'Text',
    hasData: true,
    fileUri: tempUri,
    textLength: text.length,
  });
  expect(files.get(content!.fileUri!)).toEqual(encoder.encode(text));
  expect(content!.fileSize).toBe(files.get(content!.fileUri!)!.byteLength);
  if (text === unicodeText) expect(content!.fileSize).not.toBe(text.length);
});

it('keeps text at the storage threshold inline', async () => {
  const text = 'a'.repeat(1000);
  jest.mocked(ClipboardProxy.getStringAsync).mockResolvedValue(text);
  const content = await new LocalClipboard().getClipboardContent();
  expect(content).toMatchObject({ hasData: false, text, textLength: 1000 });
  expect(content!.fileSize).toBeUndefined();
  expect(writes).not.toHaveBeenCalled();
});

it('uses actual bytes when history records contain legacy character metadata', async () => {
  useHistoryFile(unicodeBytes);
  const content = await new LocalClipboard().getClipboardContent();
  expect(content).toMatchObject({
    hasData: true,
    fileUri: historyUri,
    fileSize: unicodeBytes.byteLength,
    textLength: unicodeText.length,
  });
  expect(writes).not.toHaveBeenCalled();
});

it('reuses a complete temp file without rewriting it', async () => {
  files.set(tempUri, unicodeBytes);
  const content = await new LocalClipboard().getClipboardContent();
  expect(content).toMatchObject({
    hasData: true,
    fileUri: tempUri,
    fileSize: unicodeBytes.byteLength,
    textLength: unicodeText.length,
  });
  expect(writes).not.toHaveBeenCalled();
});

it.each(['history', 'temp'] as const)(
  'validates a reused %s cache once across clipboard polls',
  async (cache) => {
    if (cache === 'history') useHistoryFile(unicodeBytes);
    else files.set(tempUri, unicodeBytes);
    const clipboard = new LocalClipboard();
    await clipboard.getClipboardContent();
    await clipboard.getClipboardContent();
    expect(reads).toHaveBeenCalledTimes(1);
  }
);

it.each(['history', 'temp'] as const)(
  'replaces a truncated %s cache with complete text',
  async (cache) => {
    const incomplete = encoder.encode(unicodeText.slice(0, 200));
    if (cache === 'history') useHistoryFile(incomplete);
    else files.set(tempUri, incomplete);
    const content = await new LocalClipboard().getClipboardContent();
    expect(content).toMatchObject({ hasData: true, fileUri: tempUri });
    expect(files.get(tempUri)).toEqual(unicodeBytes);
    expect(content!.fileSize).toBe(unicodeBytes.byteLength);
  }
);

it.each(['history', 'temp'] as const)(
  'rejects same-size incorrect %s cache text',
  async (cache) => {
    const incorrect = encoder.encode(unicodeText.replace('完整', '错误'));
    expect(incorrect.byteLength).toBe(unicodeBytes.byteLength);
    if (cache === 'history') useHistoryFile(incorrect);
    else files.set(tempUri, incorrect);
    const content = await new LocalClipboard().getClipboardContent();
    expect(content).toMatchObject({ hasData: true, fileUri: tempUri });
    expect(files.get(tempUri)).toEqual(unicodeBytes);
  }
);

it('keeps inline text character metadata without a file byte size', async () => {
  const text = '短文本🚀';
  jest.mocked(ClipboardProxy.getStringAsync).mockResolvedValue(text);
  const content = await new LocalClipboard().getClipboardContent();
  expect(content).toMatchObject({ hasData: false, text, textLength: text.length });
  expect(content!.fileSize).toBeUndefined();
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
  expect(content).toMatchObject({ hasData: false, text, textLength: text.length });
  expect(content!.fileSize).toBeUndefined();
});

it.each(['你好', unicodeText])(
  'keeps history and synchronized text size in characters',
  async (text) => {
    jest.mocked(ClipboardProxy.getStringAsync).mockResolvedValue(text);
    const content = await new LocalClipboard().getClipboardContent();
    const item = clipboardContentToItem(content!);
    expect(item.size).toBe(text.length);
    expect(historyItemToDto(item).size).toBe(text.length);
    const restored = historyItemToContent(item);
    expect(restored.textLength).toBe(text.length);
    expect(restored.fileSize).toBeUndefined();
  }
);

it('uses inline text length when converting legacy byte metadata', () => {
  const item = clipboardContentToItem({ type: 'Text', text: '你好', hasData: false, fileSize: 6 });
  expect(item.size).toBe(2);
  expect(
    profileDtoToContent({ type: 'Text', text: '你好', hasData: false, hash: 'hash', size: 6 })
  ).toMatchObject({ textLength: 2 });
});

it('uploads local file-backed text with its full character count rather than bytes or preview length', async () => {
  const content = await new LocalClipboard().getClipboardContent();
  const profile = await contentToProfileDto(content!);
  expect(profile.size).toBe(unicodeText.length);
  expect(profile.size).not.toBe(content!.fileSize);
  expect(profile.size).not.toBe(content!.text.length);
});

it.each(['你好🚀', ''])(
  'uploads inline text with its character count, including empty text',
  async (text) => {
    const profile = await contentToProfileDto({
      type: 'Text',
      text,
      hasData: false,
      profileHash: 'inline-hash',
    });
    expect(profile.size).toBe(text.length);
    expect(profile.hasData).toBe(false);
  }
);

it.each(['Image', 'File', 'Group'] as const)('keeps %s upload sizes in bytes', async (type) => {
  const profile = await contentToProfileDto({
    type,
    text: 'data',
    hasData: true,
    fileUri: 'file:///data',
    fileName: 'data',
    profileHash: 'hash',
    fileSize: 4096,
  });
  expect(profile.size).toBe(4096);
});

it.each([40000, 0, undefined])(
  'preserves remote character metadata (server size=%s) across history and upload',
  async (size) => {
    const preview = '预览文本🚀';
    const content = profileDtoToContent({
      type: 'Text',
      text: preview,
      hash: 'remote-hash',
      hasData: true,
      dataName: 'remote.txt',
      size,
    });
    const expected = size || preview.length;
    expect(content.textLength).toBe(expected);
    expect(content.fileSize).toBeUndefined();
    const item = clipboardContentToItem(content);
    expect(item.size).toBe(expected);
    expect(historyItemToDto(item).size).toBe(expected);
    expect((await contentToProfileDto({ ...content, fileUri: 'file:///remote.txt' })).size).toBe(
      expected
    );
  }
);

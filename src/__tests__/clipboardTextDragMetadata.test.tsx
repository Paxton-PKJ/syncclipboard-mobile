import React from 'react';
// @ts-expect-error React Native provides the renderer without its type declarations.
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { CurrentClipboardCard } from '../components/CurrentClipboardCard';
import { profileDtoToContent } from '../utils/clipboard/convert';
import { downloadForStorage } from '../services/client/StorageClient';
import { historyService } from '../services/history/HistoryService';
import { sha256 } from 'js-sha256';

// 仅验证数据到 UI/原生桥的边界，使用轻量节点避免加载 React Native 文本与图片实现。
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  StyleSheet: { create: (styles: object) => styles },
  View: 'View',
  Text: 'Text',
  Image: 'Image',
  TouchableOpacity: 'TouchableOpacity',
  Linking: {},
  Share: {},
}));
jest.mock('native-util', () => {
  const React = jest.requireActual('react');
  return {
    DragSource: 'DragSource',
    DragGestureSurface: React.forwardRef((props: object, ref: unknown) => {
      React.useImperativeHandle(ref, () => ({
        startDrag: mockStartDrag,
        cancelGesture: jest.fn(async () => undefined),
      }));
      return React.createElement('DragGestureSurface', props);
    }),
  };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../hooks/useTheme', () => ({ useTheme: () => ({ theme: { colors: {} } }) }));
jest.mock('../stores', () => ({ useSettingsStore: () => ({ config: {} }) }));
jest.mock('../stores/messageStore', () => ({
  useMessageStore: (selector?: (state: { showMessage: unknown }) => unknown) => {
    const state = { showMessage: jest.fn() };
    return selector ? selector(state) : state;
  },
}));
jest.mock('../utils/fileActions', () => ({}));
jest.mock('../utils/clipboard/clipboardContentUtils', () => ({}));
jest.mock('../utils/index', () => jest.requireActual('../utils/textUtils'));
jest.mock('../components/ClipboardTypeIcon', () => ({ ClipboardTypeIcon: 'ClipboardTypeIcon' }));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('../services/history/HistoryService', () => ({
  historyService: { getItem: jest.fn(), addItem: jest.fn() },
}));
jest.mock('../services/ClientFactory', () => ({
  getAPIClient: jest.fn(async () => ({ downloadFile: mockDownloadFile })),
}));
jest.mock('../utils/fileStorage', () => ({
  prepareTempFilePath: (name: string) => `file:///cache/${name}`,
}));
jest.mock('../utils/hash', () => ({}));

const mockStartDrag = jest.fn();
const mockDownloadFile = jest.fn();
const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousAct: boolean | undefined;
let root: ReturnType<typeof TestRenderer.create> | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  mockStartDrag.mockResolvedValue({ started: true });
  mockDownloadFile.mockImplementation(async (_name: string, uri: string) => uri);
  jest.mocked(historyService.getItem).mockResolvedValue(null);
  jest.mocked(historyService.addItem).mockImplementation(async (item) => item);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
  jest.useRealTimers();
});

function displaysCount(count: number): boolean {
  return root!.root
    .findAllByType(Text)
    .some(
      (node: { props: { children: unknown } }) =>
        node.props.children === count.toLocaleString('zh-CN')
    );
}

async function requestDrag() {
  const surface = root!.root.findByType('DragGestureSurface');
  const source = root!.root.findByType('DragSource');
  await act(async () =>
    surface.props.onDragRequested({
      nativeEvent: { gestureId: 7, sourceId: source.props.sourceId },
    })
  );
}

it.each([40000, 0, undefined])(
  'displays full remote character metadata with preview fallback (size=%s)',
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
    await act(async () => {
      root = TestRenderer.create(
        <CurrentClipboardCard clipboard={content} isRemote onCopy={jest.fn()} />
      );
    });
    expect(displaysCount(size || preview.length)).toBe(true);
  }
);

it('drags downloaded WebDAV Unicode text by hash without passing character counts as bytes', async () => {
  // 刚超过桌面端的 10KB 预览阈值；只需少量中文和 emoji，卡片渲染短预览。
  const full = `远端中文🚀${'a'.repeat(10231)}TAIL`;
  const hash = sha256(full).toUpperCase();
  const remote = profileDtoToContent({
    type: 'Text',
    text: '远端预览',
    hash,
    hasData: true,
    dataName: 'remote.txt',
    size: full.length,
  });
  const downloaded = await downloadForStorage(remote);
  const uri = 'file:///cache/remote.txt';
  expect(downloaded.fileUri).toBe(uri);
  expect(historyService.addItem).toHaveBeenCalledWith(
    expect.objectContaining({ size: full.length })
  );
  await act(async () => {
    root = TestRenderer.create(
      <CurrentClipboardCard clipboard={downloaded} isRemote onCopy={jest.fn()} />
    );
  });
  await requestDrag();
  expect(mockStartDrag).toHaveBeenCalledWith(7, [{ id: hash, kind: 'textFile', fileUri: uri }]);
  expect(displaysCount(full.length)).toBe(true);
});

it('keeps local text file bytes out of the drag payload and displays the complete character count', async () => {
  const content = {
    type: 'Text' as const,
    text: 'local preview...',
    hasData: true,
    fileUri: 'file:///cache/full.txt',
    fileSize: 1012,
    textLength: 1001,
  };
  await act(async () => {
    root = TestRenderer.create(<CurrentClipboardCard clipboard={content} onCopy={jest.fn()} />);
  });
  await requestDrag();
  expect(mockStartDrag).toHaveBeenCalledWith(7, [
    { id: 'clipboard-text', kind: 'textFile', fileUri: content.fileUri },
  ]);
  expect(displaysCount(1001)).toBe(true);
});

it('shows character counts for remote text metadata instead of byte units', async () => {
  const content = profileDtoToContent({
    type: 'Text',
    text: 'preview...',
    hash: 'hash',
    hasData: true,
    size: 4096,
  });
  await act(async () => {
    root = TestRenderer.create(
      <CurrentClipboardCard clipboard={content} isRemote onCopy={jest.fn()} />
    );
  });
  expect(displaysCount(4096)).toBe(true);
});

import React from 'react';
// @ts-expect-error React Native provides the renderer without its type declarations.
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { CurrentClipboardCard } from '../components/CurrentClipboardCard';
import { profileDtoToContent } from '../utils/clipboard/convert';

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
const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousAct: boolean | undefined;
let root: ReturnType<typeof TestRenderer.create> | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
  jest.useRealTimers();
});

function displaysLabel(label: string): boolean {
  return root!.root
    .findAllByType(Text)
    .some((node: { props: { children: unknown } }) => node.props.children === label);
}

function displaysCount(count: number): boolean {
  return displaysLabel(count.toLocaleString('zh-CN'));
}

it('displays full remote character metadata when available and hides preview length when missing', async () => {
  const preview = '预览文本🚀';
  const withSize = profileDtoToContent({
    type: 'Text',
    text: preview,
    hash: 'remote-hash',
    hasData: true,
    dataName: 'remote.txt',
    size: 40000,
  });
  await act(async () => {
    root = TestRenderer.create(
      <CurrentClipboardCard clipboard={withSize} isRemote onCopy={jest.fn()} />
    );
  });
  expect(displaysCount(40000)).toBe(true);

  for (const size of [0, undefined] as const) {
    const unknownSize = profileDtoToContent({
      type: 'Text',
      text: preview,
      hash: `remote-hash-${String(size)}`,
      hasData: true,
      dataName: 'remote.txt',
      size,
    });
    await act(async () => {
      root!.update(<CurrentClipboardCard clipboard={unknownSize} isRemote onCopy={jest.fn()} />);
    });
    expect(displaysCount(preview.length)).toBe(false);
    expect(displaysLabel(String(preview.length))).toBe(false);
  }
});

it('displays file byte size for external text when character length is unknown and character count for inline text', async () => {
  const preview = '预览文本🚀';
  await act(async () => {
    root = TestRenderer.create(
      <CurrentClipboardCard
        clipboard={{
          type: 'Text',
          text: preview,
          hasData: true,
          fileUri: 'file:///cache/remote.txt',
          fileName: 'remote.txt',
          fileSize: 2048,
        }}
        isRemote
        onCopy={jest.fn()}
      />
    );
  });
  expect(displaysLabel('2.0 KB')).toBe(true);
  expect(displaysCount(preview.length)).toBe(false);

  const inlineText = '完整内联🚀';
  await act(async () => {
    root!.update(
      <CurrentClipboardCard
        clipboard={{
          type: 'Text',
          text: inlineText,
          hasData: false,
        }}
        onCopy={jest.fn()}
      />
    );
  });
  expect(displaysCount(inlineText.length)).toBe(true);
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

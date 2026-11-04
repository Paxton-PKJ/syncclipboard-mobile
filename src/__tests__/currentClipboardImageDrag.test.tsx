import React from 'react';
// @ts-expect-error React Native provides the renderer without its type declarations.
import TestRenderer, { act } from 'react-test-renderer';
import { Image, Platform } from 'react-native';
import { CurrentClipboardCard } from '../components/CurrentClipboardCard';
import type { ClipboardContent } from '../types/clipboard';

jest.mock('native-util', () => ({ ImageDragSource: 'ImageDragSource' }));
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

async function render(content: ClipboardContent, remote = true, acting = false) {
  await act(async () => {
    root = TestRenderer.create(
      <CurrentClipboardCard
        clipboard={content}
        isRemote={remote}
        acting={acting}
        onCopy={jest.fn()}
      />
    );
  });
}

function sources() {
  return root.root.findAllByType('ImageDragSource');
}

async function loadImage() {
  await act(async () => root.root.findByType(Image).props.onLoad());
}

it.each([
  ['remote', true],
  ['local', false],
] as const)(
  'enables dragging only after the %s image is displayed and reports native failure',
  async (_label, remote) => {
    await render(image, remote);
    expect(sources()).toHaveLength(0);
    await loadImage();
    expect(sources()).toHaveLength(1);
    expect(sources()[0].props).toMatchObject({
      fileUri: image.fileUri,
      expectedSize: 1000,
      accessibilityHint: 'clipboard.imageDragHint',
    });
    expect(mockShowMessage).not.toHaveBeenCalled();
    await act(async () => sources()[0].props.onDragStartFailed());
    expect(mockShowMessage).toHaveBeenCalledWith('clipboard.imageDragFailed', 'error');
  }
);

it.each([
  ['active download', true, true, 'android'],
  ['active upload', false, true, 'android'],
  ['iOS', true, false, 'ios'],
  ['local iOS card', false, false, 'ios'],
] as const)('keeps an ordinary preview for %s', async (_label, remote, acting, platform) => {
  Platform.OS = platform;
  await render(image, remote, acting);
  await loadImage();
  expect(sources()).toHaveLength(0);
});

it.each(['Text', 'File', 'Group'] as const)('never enables dragging for %s', async (type) => {
  await render({ ...image, type });
  expect(sources()).toHaveLength(0);
});

it.each([true, false])(
  'does not offer dragging without a local URI (remote=%s)',
  async (remote) => {
    await render({ ...image, fileUri: undefined }, remote);
    expect(sources()).toHaveLength(0);
    expect(root.root.findAllByType(Image)).toHaveLength(0);
  }
);

it.each([true, false])('does not offer dragging for network images (remote=%s)', async (remote) => {
  await render({ ...image, fileUri: 'https://example.test/image.png' }, remote);
  await loadImage();
  expect(sources()).toHaveLength(0);
});

it.each([true, false])(
  'removes the source if the displayed image fails to load (remote=%s)',
  async (remote) => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    await render(image, remote);
    await loadImage();
    await act(async () => root.root.findByType(Image).props.onError({ nativeEvent: {} }));
    expect(sources()).toHaveLength(0);
    error.mockRestore();
  }
);

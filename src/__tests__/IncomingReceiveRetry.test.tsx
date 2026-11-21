import React from 'react';
// @ts-expect-error React Native 提供的测试 renderer 没有类型声明。
import TestRenderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';
import { awaitIncomingSession } from 'native-util';
import { DirectShareReceiveScreen } from '../screens/DirectShareReceiveScreen';
import { DropUploadOverlay } from '../components/DropReceiveOverlay';
import { setRemoteClipboard } from '../services/sync/ClipboardSyncActions';

jest.mock('../services/sync/ClipboardSyncActions', () => ({ setRemoteClipboard: jest.fn() }));
jest.mock('../services/NetworkAutoSwitchService', () => ({ networkAutoSwitchService: { ensureCurrentServer: jest.fn() } }));
jest.mock('../utils/clipboard/clipboardContentUtils', () => ({ createContentFromText: (text: string) => ({type: 'Text', text}) }));
jest.mock('../hooks/useTheme', () => ({ useTheme: () => ({ theme: { colors: {} } }) }));
jest.mock('../utils/index', () => ({}));
jest.mock('../components/ClipboardTypeIcon', () => ({ ClipboardTypeIcon: 'ClipboardTypeIcon' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const session = { sessionId: 'test', kind: 'text' as const, itemCount: 1 };
const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;
let root: ReturnType<typeof TestRenderer.create>;

beforeEach(() => {
  jest.clearAllMocks();
  previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT;
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

function hasLabel(label: string) {
  return root.root.findAllByType(Text).some((node: { props: { children: unknown } }) => node.props.children === label);
}

describe.each([DirectShareReceiveScreen, DropUploadOverlay])('%p', (Screen) => {
  it('暂存失败时提示重新传入，并隐藏同一会话的重试操作', async () => {
    jest.mocked(awaitIncomingSession).mockRejectedValueOnce(new Error('incomplete stream'));
    await act(async () => { root = TestRenderer.create(<Screen session={session} onComplete={jest.fn()} />); });
    expect(hasLabel('common.retry')).toBe(false);
    expect(root.root.findAllByType(Text).some((node: { props: { children: unknown } }) => String(node.props.children).includes('shareReceive.stageAgain'))).toBe(true);
    expect(setRemoteClipboard).not.toHaveBeenCalled();
  });

  it('上传失败后可在原会话中点击重试并成功退出', async () => {
    jest.mocked(awaitIncomingSession).mockResolvedValue({sessionId: 'test', type: 'text', text: 'complete'});
    jest.mocked(setRemoteClipboard).mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValueOnce(true);
    const complete = jest.fn();
    await act(async () => { root = TestRenderer.create(<Screen session={session} onComplete={complete} />); });
    const retry = root.root.findAllByType(TouchableOpacity).find((node: { findAllByType: (type: typeof Text) => { props: { children: unknown } }[] }) => node.findAllByType(Text).some((child) => child.props.children === 'common.retry'));
    expect(retry).toBeDefined();
    await act(async () => { await retry.props.onPress(); });
    expect(setRemoteClipboard).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

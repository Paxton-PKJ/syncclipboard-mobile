import React from 'react';
// @ts-expect-error React Native provides the renderer without its type declarations.
import TestRenderer, { act } from 'react-test-renderer';
import { Platform } from 'react-native';
import { HistoryListItem } from '../components/HistoryListItem';
import { createHistoryItem } from '../types/clipboard';

jest.mock('native-util', () => ({ HistoryDragSource: 'HistoryDragSource' }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../hooks/useTheme', () => ({ useTheme: () => ({ theme: { colors: {} } }) }));
jest.mock('../stores', () => ({ useSettingsStore: () => 'off' }));
jest.mock('../stores/transferQueueStore', () => ({ useTransferQueueStore: () => [] }));
jest.mock('../services/history/HistoryTransferQueue', () => ({}));
jest.mock('../utils/index', () => ({
  getProfileId: () => 'Text-hash',
  formatSizeWithType: () => '',
}));
jest.mock('@react-native-community/netinfo', () => ({}));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
  MaterialCommunityIcons: 'MaterialCommunityIcons',
}));
jest.mock('react-native-feather', () => ({
  Copy: 'Copy',
  Share: 'Share',
  Link2: 'Link2',
  Scissors: 'Scissors',
}));
jest.mock('../components/ClipboardTypeIcon', () => ({ ClipboardTypeIcon: 'ClipboardTypeIcon' }));
jest.mock('react-native/Libraries/Components/Touchable/TouchableOpacity', () => ({
  __esModule: true,
  default: 'TouchableOpacity',
}));

it('lets Android accessibility enter multi-select and keeps copy buttons outside native long-press recognition', async () => {
  const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
  const previousPlatform = Platform.OS;
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  Platform.OS = 'android';
  const item = createHistoryItem({
    type: 'Text',
    text: 'hello',
    profileHash: 'hash',
    hasData: false,
    timestamp: 1,
  });
  const onLongPress = jest.fn();
  const onCopy = jest.fn();
  let root: ReturnType<typeof TestRenderer.create>;
  try {
    await act(async () => {
      root = TestRenderer.create(
        <HistoryListItem
          item={item}
          onLongPress={onLongPress}
          onCopy={onCopy}
          onShare={jest.fn()}
        />
      );
    });
    const card = root!.root.findAll(
      (node: { props: { onAccessibilityAction?: unknown } }) =>
        typeof node.props.onAccessibilityAction === 'function'
    )[0];
    expect(card.props.accessibilityActions).toContainEqual({ name: 'longpress' });
    await act(async () =>
      card.props.onAccessibilityAction({ nativeEvent: { actionName: 'longpress' } })
    );
    expect(onLongPress).toHaveBeenCalledWith(item);
    const copy = root!.root.findByType('Copy').parent!;
    const disabledMarker = copy.parent!;
    expect(disabledMarker.props.gestureMode).toBe('disabled');
    await act(async () => copy.props.onPress());
    expect(onCopy).toHaveBeenCalledWith(item);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root?.unmount());
    testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
    Platform.OS = previousPlatform;
  }
});

import React from 'react';
// @ts-expect-error React Native provides the renderer without its type declarations.
import TestRenderer, { act } from 'react-test-renderer';
import { requireNativeViewManager } from 'expo-modules-core';
import * as mockSurface from '../../modules/native-util/src/DragGestureSurface';
import * as mockSource from '../../modules/native-util/src/DragSource';
import { ClipboardDragSource } from '../components/ClipboardDragSource';

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
jest.mock('expo-modules-core', () => ({ requireNativeViewManager: jest.fn() }));
jest.mock('native-util', () => ({ ...mockSurface, ...mockSource }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../stores/messageStore', () => ({
  useMessageStore: (selector?: (state: { showMessage: unknown }) => unknown) => {
    const state = { showMessage: jest.fn() };
    return selector ? selector(state) : state;
  },
}));

it.each(['Text', 'Image'] as const)(
  'imports and renders %s on iOS without looking up an Android native view',
  async (contentType) => {
    const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = testGlobal.IS_REACT_ACT_ENVIRONMENT;
    testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    let root: ReturnType<typeof TestRenderer.create>;
    try {
      await act(async () => {
        root = TestRenderer.create(
          <ClipboardDragSource
            contentType={contentType}
            item={
              contentType === 'Image'
                ? { id: 'image', kind: 'image', fileUri: 'file:///cache/image.png' }
                : { id: 'text', kind: 'text', text: 'text' }
            }
            testID="preview"
          >
            <React.Fragment>image</React.Fragment>
          </ClipboardDragSource>
        );
      });
      expect(requireNativeViewManager).not.toHaveBeenCalled();
      const views = root!.root.findAllByType('View');
      expect(
        views.some((view: { props: { testID?: string } }) => view.props.testID === 'preview')
      ).toBe(true);
      expect(
        views.every((view: { props: { fileUri?: string } }) => view.props.fileUri === undefined)
      ).toBe(true);
    } finally {
      await act(async () => root?.unmount());
      testGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  }
);

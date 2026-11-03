import React from 'react';
// @ts-expect-error React Native provides the renderer without its type declarations.
import TestRenderer, { act } from 'react-test-renderer';
import { requireNativeViewManager } from 'expo-modules-core';
import { ImageDragSource } from '../../modules/native-util/src/ImageDragSource';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' }, View: 'View' }));
jest.mock('expo-modules-core', () => ({ requireNativeViewManager: jest.fn() }));

it('imports and renders on iOS without looking up an Android native view', async () => {
  const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = testGlobal.IS_REACT_ACT_ENVIRONMENT;
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  let root: ReturnType<typeof TestRenderer.create>;
  try {
    await act(async () => {
      root = TestRenderer.create(
        <ImageDragSource fileUri="file:///cache/image.png" testID="preview">
          <React.Fragment>image</React.Fragment>
        </ImageDragSource>
      );
    });
    expect(requireNativeViewManager).not.toHaveBeenCalled();
    expect(root.root.findByType('View').props.testID).toBe('preview');
    expect(root.root.findByType('View').props.fileUri).toBeUndefined();
  } finally {
    await act(async () => root?.unmount());
    testGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

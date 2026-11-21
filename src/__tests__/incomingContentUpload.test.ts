jest.mock('../utils/clipboard/clipboardContentUtils', () => ({
  createContentFromText: jest.fn(),
  createContentFromFile: jest.fn(),
  createContentFromMultipleFiles: jest.fn(),
}));

jest.mock('../services/sync/ClipboardSyncActions', () => ({
  setRemoteClipboard: jest.fn(),
}));

import {
  uploadIncomingSession,
  type IncomingUploadDeps,
} from '../services/sync/incomingContentUpload';

function createMocks() {
  const deps: IncomingUploadDeps = {
    awaitSession: jest.fn(),
    cleanupSession: jest.fn(),
    createContentFromText: jest.fn(),
    createContentFromFile: jest.fn(),
    createContentFromMultipleFiles: jest.fn(),
    setRemoteClipboard: jest.fn(),
  };
  const callbacks = {
    setLoadingText: jest.fn(),
    setProgress: jest.fn(),
    setPreviewText: jest.fn(),
    setPreviewImage: jest.fn(),
    t: (key: string) => key,
  };
  return { deps, callbacks };
}

describe('uploadIncomingSession', () => {
  it('显式拒绝同时包含文件与文本的混合拖入，不执行任何暂存、上传或部分放行', async () => {
    const { deps, callbacks } = createMocks();
    const controller = new AbortController();

    await expect(
      uploadIncomingSession(
        {
          sessionId: '',
          kind: 'unsupported_mixed',
          itemCount: 0,
        },
        controller.signal,
        callbacks,
        deps
      )
    ).rejects.toThrow('dropReceive.mixedContentUnsupported');

    expect(deps.awaitSession).not.toHaveBeenCalled();
    expect(deps.createContentFromText).not.toHaveBeenCalled();
    expect(deps.createContentFromFile).not.toHaveBeenCalled();
    expect(deps.createContentFromMultipleFiles).not.toHaveBeenCalled();
    expect(deps.setRemoteClipboard).not.toHaveBeenCalled();
    expect(deps.cleanupSession).not.toHaveBeenCalled();
  });

  it('单文件会话上传成功后清理会话，失败保留会话以便重试', async () => {
    const { deps, callbacks } = createMocks();
    const controller = new AbortController();
    (deps.awaitSession as jest.Mock).mockResolvedValue({
      sessionId: 's-1',
      type: 'file',
      file: {
        uri: 'file:///cache/.incoming_transfer/s-1/a.png',
        fileName: 'a.png',
        mimeType: 'image/png',
        size: 128,
      },
    });
    const fakeContent = {
      type: 'Image',
      text: 'a.png',
      hasData: true,
      fileName: 'a.png',
      fileUri: 'file:///cache/.incoming_transfer/s-1/a.png',
    };
    (deps.createContentFromFile as jest.Mock).mockResolvedValue(fakeContent);
    (deps.setRemoteClipboard as jest.Mock).mockRejectedValueOnce(new Error('HTTP 503'));

    await expect(
      uploadIncomingSession(
        { sessionId: 's-1', kind: 'file', itemCount: 1 },
        controller.signal,
        callbacks,
        deps
      )
    ).rejects.toThrow('HTTP 503');
    expect(deps.cleanupSession).not.toHaveBeenCalled();

    (deps.setRemoteClipboard as jest.Mock).mockResolvedValueOnce(true);
    await uploadIncomingSession(
      { sessionId: 's-1', kind: 'file', itemCount: 1 },
      controller.signal,
      callbacks,
      deps
    );
    expect(deps.cleanupSession).toHaveBeenCalledWith('s-1');
  });

  it('上传被另一项操作抢占时，仍可用原会话重试', async () => {
    const { deps, callbacks } = createMocks();
    const session = { sessionId: 'shared', kind: 'text' as const, itemCount: 1 };
    const signal = new AbortController().signal;
    jest
      .mocked(deps.awaitSession)
      .mockResolvedValue({ sessionId: 'shared', type: 'text', text: '正文' });
    jest
      .mocked(deps.setRemoteClipboard)
      .mockRejectedValueOnce(Object.assign(new Error('superseded'), { name: 'AbortError' }))
      .mockResolvedValueOnce(true);

    await expect(uploadIncomingSession(session, signal, callbacks, deps)).rejects.toThrow(
      'superseded'
    );
    expect(deps.cleanupSession).not.toHaveBeenCalled();
    await uploadIncomingSession(session, signal, callbacks, deps);
    expect(deps.cleanupSession).toHaveBeenCalledTimes(1);
  });

  it('外部取消时清理暂存会话', async () => {
    const { deps, callbacks } = createMocks();
    const controller = new AbortController();
    (deps.awaitSession as jest.Mock).mockImplementation(async () => {
      controller.abort();
      const err = new Error('Operation was aborted');
      err.name = 'AbortError';
      throw err;
    });

    await expect(
      uploadIncomingSession(
        { sessionId: 's-abort', kind: 'file', itemCount: 1 },
        controller.signal,
        callbacks,
        deps
      )
    ).rejects.toThrow('Operation was aborted');

    expect(deps.cleanupSession).toHaveBeenCalledWith('s-abort');
  });
});

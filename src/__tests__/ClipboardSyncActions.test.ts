import type { ClipboardContent } from '../types/clipboard';

const mockDownloadData = jest.fn();
const mockSetRemoteClipboard = jest.fn();

jest.mock('../services/history/HistoryService', () => ({
  historyService: {
    addLocalContent: jest.fn(),
    getItem: jest.fn(async () => null),
  },
}));

jest.mock('../services/client/ClientService', () => ({
  getClientService: () => ({
    downloadData: mockDownloadData,
    setRemoteClipboard: mockSetRemoteClipboard,
  }),
}));

jest.mock('../services/ConfigService', () => ({
  configService: {
    getActiveServer: jest.fn(),
  },
}));

jest.mock('../services/NetworkAutoSwitchService', () => ({
  networkAutoSwitchService: {
    ensureCurrentServer: jest.fn(async () => undefined),
  },
}));

jest.mock('../services/sync/RemoteClipboardMonitor', () => ({
  remoteClipboardMonitor: {
    fetchLatest: jest.fn(),
    refresh: jest.fn(),
  },
}));

jest.mock('../services/sync/SyncState', () => ({
  clipboardSyncState: {
    getState: jest.fn(() => ({ remoteContent: null })),
    setState: jest.fn(),
    setDownloadingRemote: jest.fn(),
    setDownloadProgress: jest.fn(),
    clearDownloadState: jest.fn(),
    setUploadingClipboard: jest.fn(),
    setUploadProgress: jest.fn(),
    setRemoteContent: jest.fn(),
  },
}));

jest.mock('../services/clipboard/ClipboardMonitor', () => ({
  clipboardMonitor: {
    getLastContent: jest.fn(),
    triggerCheck: jest.fn(),
  },
}));

jest.mock('../services/clipboard/LocalClipboard', () => ({
  localClipboard: {
    setClipboardContent: jest.fn(),
  },
}));

import {
  downloadRemoteClipboard,
  setRemoteClipboard,
  setLocalClipboardFromRemote,
} from '../services/sync/ClipboardSyncActions';
import { localClipboard } from '../services/clipboard/LocalClipboard';
import { configService } from '../services/ConfigService';
import { networkAutoSwitchService } from '../services/NetworkAutoSwitchService';
import { remoteClipboardMonitor } from '../services/sync/RemoteClipboardMonitor';

describe('setRemoteClipboard', () => {
  const localContent: ClipboardContent = {
    type: 'Text',
    text: 'local text',
    hasData: false,
    profileHash: 'local',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (configService.getActiveServer as jest.Mock).mockResolvedValue({
      id: 'home',
      type: 'syncclipboard',
      url: 'https://home.example',
    });
  });

  it('上传底层不执行网络自动切换预检', async () => {
    await setRemoteClipboard(localContent, new AbortController().signal);

    expect(networkAutoSwitchService.ensureCurrentServer).not.toHaveBeenCalled();
    expect(mockSetRemoteClipboard).toHaveBeenCalledWith(
      localContent,
      expect.any(Function),
      expect.any(AbortSignal)
    );
  });
});

describe('downloadRemoteClipboard', () => {
  const remoteContent: ClipboardContent = {
    type: 'Image',
    text: 'remote.png',
    hasData: true,
    fileName: 'remote.png',
    fileSize: 10,
    profileHash: 'remote',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDownloadData.mockResolvedValue({ ...remoteContent, fileUri: 'file:///remote.png' });
  });

  it('信任已获取的远程内容，下载前不重新拉取', async () => {
    await downloadRemoteClipboard(remoteContent);

    expect(remoteClipboardMonitor.fetchLatest).not.toHaveBeenCalled();
    expect(mockDownloadData).toHaveBeenCalledWith(
      remoteContent,
      expect.any(Function),
      expect.any(AbortSignal)
    );
  });

  it('手动复制字符大小未知的远端文本时先下载完整文件', async () => {
    const remote: ClipboardContent = {
      type: 'Text',
      text: 'preview',
      hasData: true,
      fileName: 'full.txt',
      profileHash: 'remote-text',
    };
    const downloaded = { ...remote, fileUri: 'file:///full.txt' };
    mockDownloadData.mockResolvedValue(downloaded);
    await setLocalClipboardFromRemote(undefined, undefined, remote);
    expect(mockDownloadData).toHaveBeenCalledWith(
      remote,
      expect.any(Function),
      expect.any(AbortSignal)
    );
    expect(localClipboard.setClipboardContent).toHaveBeenCalledWith(downloaded, true);
  });
});

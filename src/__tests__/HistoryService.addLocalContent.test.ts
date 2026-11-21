import { sha256 } from 'js-sha256';
import { File } from 'expo-file-system';
import { nativeCopyFile } from 'native-util';
import type { ClipboardContent } from '../types/clipboard';

const mockFiles = new Map<string, Uint8Array>();

jest.mock('@/utils/hash', () => {
  const actual = jest.requireActual('../utils/hash');
  const { sha256: computeSha256 } = jest.requireActual('js-sha256') as typeof import('js-sha256');
  const hashFile = async (uri: string): Promise<string> => {
    const bytes = mockFiles.get(uri);
    if (!bytes) throw new Error(`File not found: ${uri}`);
    return computeSha256(bytes).toUpperCase();
  };
  return {
    ...actual,
    calculateFileHash: jest.fn(hashFile),
    calculateFileProfileHash: jest.fn(async (uri: string, fileName?: string) => {
      const fileHash = await hashFile(uri);
      const name = fileName || uri.split(/[/\\]/).pop() || 'unknown';
      return computeSha256(`${name}|${fileHash}`).toUpperCase();
    }),
  };
});

jest.mock('@/utils/fileStorage', () => ({
  getHistoryFileUri: jest.fn(async (type: string, profileHash: string, fileName: string) => {
    const uri = `file:///documents/clipboards/history/${type}-${profileHash}/${fileName}`;
    return mockFiles.has(uri) ? uri : null;
  }),
  prepareHistoryFileUri: jest.fn(async (type: string, profileHash: string, fileName: string) => {
    return `file:///documents/clipboards/history/${type}-${profileHash}/${fileName}`;
  }),
}));

jest.mock('@/storage', () => ({
  historyStorage: {
    setOnChangeCallback: jest.fn(),
    addItem: jest.fn(async (item) => item),
    getItem: jest.fn(),
    getItemByLocalHash: jest.fn(),
  },
}));

const mockClientSetRemoteClipboard = jest.fn();
jest.mock('../services/client/ClientService', () => ({
  getClientService: () => ({
    setRemoteClipboard: mockClientSetRemoteClipboard,
  }),
}));

jest.mock('../services/ConfigService', () => ({
  configService: {
    getActiveServer: jest.fn(async () => ({
      id: 'webdav-1',
      type: 'webdav',
      url: 'https://webdav.example',
    })),
  },
}));

jest.mock('../services/sync/SyncState', () => ({
  clipboardSyncState: {
    getState: jest.fn(() => ({ remoteContent: null })),
    setRemoteContent: jest.fn(),
  },
}));

jest.mock('../services/sync/RemoteClipboardMonitor', () => ({
  remoteClipboardMonitor: {
    fetchLatest: jest.fn(),
    refresh: jest.fn(),
  },
}));

jest.mock('../services/clipboard/ClipboardMonitor', () => ({
  clipboardMonitor: {
    getLastContent: jest.fn(),
  },
}));

jest.mock('../services/clipboard/LocalClipboard', () => ({
  localClipboard: {
    setClipboardContent: jest.fn(),
  },
}));

jest.mock('@/i18n', () => ({
  __esModule: true,
  default: { t: (key: string) => key },
}));

import { historyService } from '../services/history/HistoryService';
import { setRemoteClipboard } from '../services/sync/ClipboardSyncActions';
import { clipboardSyncState } from '../services/sync/SyncState';

const encoder = new TextEncoder();

describe('HistoryService.addLocalContent 历史副本校验与修复', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFiles.clear();

    (File as unknown as jest.Mock).mockImplementation((uri: string) => ({
      uri,
      get exists() {
        return mockFiles.has(uri);
      },
      get size() {
        return mockFiles.get(uri)?.byteLength ?? 0;
      },
      info: () => ({
        exists: mockFiles.has(uri),
        size: mockFiles.get(uri)?.byteLength ?? 0,
      }),
      delete: () => {
        mockFiles.delete(uri);
      },
    }));

    (nativeCopyFile as jest.Mock).mockImplementation(async (srcUri: string, destUri: string) => {
      const bytes = mockFiles.get(srcUri);
      if (!bytes) throw new Error(`Missing source file: ${srcUri}`);
      mockFiles.set(destUri, new Uint8Array(bytes));
    });
  });

  it('历史长文本副本已截断时，setRemoteClipboard 上传完整源字节并覆盖修复历史副本', async () => {
    const fullText = `完整正文-${'A'.repeat(1500)}-END`;
    const fullBytes = encoder.encode(fullText);
    const fullHash = sha256(fullBytes).toUpperCase();
    const fileName = `${fullHash}.txt`;
    const sourceUri = `file:///cache/temp_files/${fileName}`;
    const historyUri = `file:///documents/clipboards/history/Text-${fullHash}/${fileName}`;

    // 历史副本损坏为截断预览，而本地源临时文件完整
    mockFiles.set(historyUri, encoder.encode('截断预览'));
    mockFiles.set(sourceUri, fullBytes);

    let uploadedBytes: Uint8Array | undefined;
    mockClientSetRemoteClipboard.mockImplementation(async (content: ClipboardContent) => {
      uploadedBytes = mockFiles.get(content.fileUri!);
    });

    const content: ClipboardContent = {
      type: 'Text',
      text: fullText.slice(0, 200),
      hasData: true,
      fileName,
      fileUri: sourceUri,
      fileSize: fullBytes.byteLength,
      profileHash: fullHash,
      localClipboardHash: fullHash,
    };

    await setRemoteClipboard(content, new AbortController().signal);

    // 上传使用完整源字节，而非截断的历史副本
    expect(uploadedBytes).toEqual(fullBytes);
    // 损坏的历史副本也已被修复为完整字节，供后续远程卡片读取
    expect(mockFiles.get(historyUri)).toEqual(fullBytes);
    expect(clipboardSyncState.setRemoteContent).toHaveBeenCalledWith({
      ...content,
      fileUri: historyUri,
    });
  });

  it('同大小但内容被篡改的历史副本在复用前也会被重新写入修复', async () => {
    const fullText = '1234567890-valid-body';
    const fullBytes = encoder.encode(fullText);
    const corruptBytes = encoder.encode('1234567890-wrong-body');
    expect(corruptBytes.byteLength).toBe(fullBytes.byteLength);

    const fullHash = sha256(fullBytes).toUpperCase();
    const fileName = `${fullHash}.txt`;
    const sourceUri = `file:///cache/temp_files/${fileName}`;
    const historyUri = `file:///documents/clipboards/history/Text-${fullHash}/${fileName}`;

    mockFiles.set(historyUri, corruptBytes);
    mockFiles.set(sourceUri, fullBytes);

    const saved = await historyService.addLocalContent({
      type: 'Text',
      text: fullText,
      hasData: true,
      fileName,
      fileUri: sourceUri,
      fileSize: fullBytes.byteLength,
      profileHash: fullHash,
      localClipboardHash: fullHash,
    });

    expect(saved.fileUri).toBe(historyUri);
    expect(mockFiles.get(historyUri)).toEqual(fullBytes);
  });

  it('完好无损的历史副本直接复用，不触发多余复制', async () => {
    const fullText = 'intact-long-text';
    const fullBytes = encoder.encode(fullText);
    const fullHash = sha256(fullBytes).toUpperCase();
    const fileName = `${fullHash}.txt`;
    const sourceUri = `file:///cache/temp_files/${fileName}`;
    const historyUri = `file:///documents/clipboards/history/Text-${fullHash}/${fileName}`;

    mockFiles.set(historyUri, new Uint8Array(fullBytes));
    mockFiles.set(sourceUri, fullBytes);

    const saved = await historyService.addLocalContent({
      type: 'Text',
      text: fullText,
      hasData: true,
      fileName,
      fileUri: sourceUri,
      fileSize: fullBytes.byteLength,
      profileHash: fullHash,
      localClipboardHash: fullHash,
    });

    expect(saved.fileUri).toBe(historyUri);
    expect(nativeCopyFile).not.toHaveBeenCalled();
  });

  it('Image 与 Group 历史副本损坏时也会从源文件修复', async () => {
    const imageBytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const imageHash = sha256(imageBytes).toUpperCase();
    const imageProfileHash = sha256(`pic.png|${imageHash}`).toUpperCase();
    const imageSrc = 'file:///cache/.incoming_transfer/s1/pic.png';
    const imageHist = `file:///documents/clipboards/history/Image-${imageProfileHash}/pic.png`;
    mockFiles.set(imageHist, new Uint8Array([1, 2]));
    mockFiles.set(imageSrc, imageBytes);

    await historyService.addLocalContent({
      type: 'Image',
      text: 'pic.png',
      hasData: true,
      fileName: 'pic.png',
      fileUri: imageSrc,
      fileSize: imageBytes.byteLength,
      profileHash: imageProfileHash,
      localClipboardHash: imageHash,
    });
    expect(mockFiles.get(imageHist)).toEqual(imageBytes);

    const zipBytes = new Uint8Array([80, 75, 3, 4, 10, 20, 30, 40]);
    const groupHash = 'A'.repeat(64);
    const groupSrc = 'file:///cache/temp_files/File_1.zip';
    const groupHist = `file:///documents/clipboards/history/Group-${groupHash}/File_1.zip`;
    mockFiles.set(groupHist, new Uint8Array([80, 75, 0, 0, 0, 0, 0, 0]));
    mockFiles.set(groupSrc, zipBytes);

    await historyService.addLocalContent({
      type: 'Group',
      text: 'a.png\nb.png',
      hasData: true,
      fileName: 'File_1.zip',
      fileUri: groupSrc,
      fileSize: zipBytes.byteLength,
      profileHash: groupHash,
      localClipboardHash: groupHash,
    });
    expect(mockFiles.get(groupHist)).toEqual(zipBytes);
  });
});

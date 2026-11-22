import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { sha256 } from 'js-sha256';
import { File } from 'expo-file-system';
import { nativeCopyFile, nativeReplaceFile } from 'native-util';
import type { ClipboardContent } from '../types/clipboard';
import { calculateFileHash } from '@/utils/hash';
import { getHistoryFileUri, prepareHistoryFileUri } from '@/utils/fileStorage';

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

import { prepareIncomingHistoryFile } from '../services/sync/incomingHistoryFile';
import { setRemoteClipboard } from '../services/sync/ClipboardSyncActions';
import { clipboardSyncState } from '../services/sync/SyncState';

const encoder = new TextEncoder();

describe('传入会话的持久副本校验与修复', () => {
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

    (nativeReplaceFile as jest.Mock).mockImplementation(async (srcUri: string, destUri: string) => {
      const bytes = mockFiles.get(srcUri);
      if (!bytes) throw new Error(`Missing staging file: ${srcUri}`);
      mockFiles.set(destUri, new Uint8Array(bytes));
      mockFiles.delete(srcUri);
    });
  });

  it('接收合法长文件名时，暂存和最终文件名均符合 Android 单段字节限制', async () => {
    const fileName = `${'界'.repeat(80)}.png`;
    const bytes = encoder.encode('image');
    const fileUri = `file:///cache/${fileName}`;
    mockFiles.set(fileUri, bytes);
    const profileHash = sha256(`${fileName}|${sha256(bytes).toUpperCase()}`).toUpperCase();
    const saved = await prepareIncomingHistoryFile({
      type: 'Image',
      text: fileName,
      fileName,
      fileUri,
      profileHash,
      hasData: true,
    });
    const stagingUri = jest.mocked(nativeCopyFile).mock.calls[0][1];
    expect(
      encoder.encode(decodeURIComponent(stagingUri.split('/').pop()!)).length
    ).toBeLessThanOrEqual(255);
    expect(saved.fileUri?.endsWith(`/${fileName}`)).toBe(true);
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

    await setRemoteClipboard(
      content,
      new AbortController().signal,
      undefined,
      prepareIncomingHistoryFile
    );

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

    const saved = await prepareIncomingHistoryFile({
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

    const saved = await prepareIncomingHistoryFile({
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

    await prepareIncomingHistoryFile({
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

    await prepareIncomingHistoryFile({
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

  it('原本哈希正确的 19 字节历史正文不会被已截断的 3 字节临时源覆盖，且 setRemoteClipboard 上传完整历史副本', async () => {
    const validText = '1234567890123456789';
    const validBytes = encoder.encode(validText);
    expect(validBytes.byteLength).toBe(19);
    const truncatedBytes = encoder.encode('123');
    expect(truncatedBytes.byteLength).toBe(3);

    const validHash = sha256(validBytes).toUpperCase();
    const fileName = `${validHash}.txt`;
    const sourceUri = `file:///cache/temp_files/${fileName}`;
    const historyUri = `file:///documents/clipboards/history/Text-${validHash}/${fileName}`;

    mockFiles.set(historyUri, new Uint8Array(validBytes));
    mockFiles.set(sourceUri, truncatedBytes);

    let uploadedBytes: Uint8Array | undefined;
    mockClientSetRemoteClipboard.mockImplementation(async (content: ClipboardContent) => {
      uploadedBytes = mockFiles.get(content.fileUri!);
    });

    const saved = await prepareIncomingHistoryFile({
      type: 'Text',
      text: validText,
      hasData: true,
      fileName,
      fileUri: sourceUri,
      fileSize: validBytes.byteLength,
      profileHash: validHash,
      localClipboardHash: validHash,
    });

    expect(saved.fileUri).toBe(historyUri);
    expect(mockFiles.get(historyUri)).toEqual(validBytes);
    expect(nativeCopyFile).not.toHaveBeenCalled();
    expect(nativeReplaceFile).not.toHaveBeenCalled();

    await setRemoteClipboard(
      {
        type: 'Text',
        text: validText,
        hasData: true,
        fileName,
        fileUri: sourceUri,
        fileSize: validBytes.byteLength,
        profileHash: validHash,
        localClipboardHash: validHash,
      },
      new AbortController().signal,
      undefined,
      prepareIncomingHistoryFile
    );

    expect(uploadedBytes).toEqual(validBytes);
    expect(mockFiles.get(historyUri)).toEqual(validBytes);
  });

  it('历史副本损坏且临时源也截断或哈希不匹配时拒绝覆盖并保留原文件', async () => {
    const validText = '1234567890123456789';
    const validBytes = encoder.encode(validText);
    const validHash = sha256(validBytes).toUpperCase();
    const fileName = `${validHash}.txt`;
    const sourceUri = `file:///cache/temp_files/${fileName}`;
    const historyUri = `file:///documents/clipboards/history/Text-${validHash}/${fileName}`;
    const oldCorrupt = encoder.encode('old-corrupt');

    mockFiles.set(historyUri, oldCorrupt);
    mockFiles.set(sourceUri, encoder.encode('bad'));

    await expect(
      prepareIncomingHistoryFile({
        type: 'Text',
        text: validText,
        hasData: true,
        fileName,
        fileUri: sourceUri,
        fileSize: validBytes.byteLength,
        profileHash: validHash,
        localClipboardHash: validHash,
      })
    ).rejects.toThrow();

    expect(mockFiles.get(historyUri)).toEqual(oldCorrupt);
    expect(nativeCopyFile).not.toHaveBeenCalled();
    expect(nativeReplaceFile).not.toHaveBeenCalled();
  });

  it('修复过程中暂存副本校验失败或原子替换失败时保留旧历史文件并清理暂存文件', async () => {
    const validText = '1234567890123456789';
    const validBytes = encoder.encode(validText);
    const validHash = sha256(validBytes).toUpperCase();
    const fileName = `${validHash}.txt`;
    const sourceUri = `file:///cache/temp_files/${fileName}`;
    const historyUri = `file:///documents/clipboards/history/Text-${validHash}/${fileName}`;
    const oldCorrupt = encoder.encode('old-corrupt');

    mockFiles.set(historyUri, oldCorrupt);
    mockFiles.set(sourceUri, validBytes);

    // 场景 1: 复制生成的暂存副本损坏 -> 校验失败 -> 清理暂存、保留旧文件、不触发 replace
    (nativeCopyFile as jest.Mock).mockImplementationOnce(async (_src: string, dest: string) => {
      mockFiles.set(dest, encoder.encode('truncated-copy'));
    });

    await expect(
      prepareIncomingHistoryFile({
        type: 'Text',
        text: validText,
        hasData: true,
        fileName,
        fileUri: sourceUri,
        profileHash: validHash,
        localClipboardHash: validHash,
      })
    ).rejects.toThrow();

    expect(mockFiles.get(historyUri)).toEqual(oldCorrupt);
    expect(nativeReplaceFile).not.toHaveBeenCalled();
    expect(Array.from(mockFiles.keys()).some((k) => k.endsWith('.tmp'))).toBe(false);

    // 场景 2: 暂存校验通过，但 nativeReplaceFile 失败 -> 清理暂存、保留旧文件
    (nativeReplaceFile as jest.Mock).mockRejectedValueOnce(new Error('IO rename error'));

    await expect(
      prepareIncomingHistoryFile({
        type: 'Text',
        text: validText,
        hasData: true,
        fileName,
        fileUri: sourceUri,
        profileHash: validHash,
        localClipboardHash: validHash,
      })
    ).rejects.toThrow('IO rename error');

    expect(mockFiles.get(historyUri)).toEqual(oldCorrupt);
    expect(Array.from(mockFiles.keys()).some((k) => k.endsWith('.tmp'))).toBe(false);
  });

  it('File、Image、Group 在历史完好而临时源截断时均保留完整历史副本', async () => {
    const fileBytes = encoder.encode('complete-binary-payload');
    const fileHash = sha256(fileBytes).toUpperCase();
    const fileProfileHash = sha256(`doc.bin|${fileHash}`).toUpperCase();
    const fileSrc = 'file:///cache/temp_files/doc.bin';
    const fileHist = `file:///documents/clipboards/history/File-${fileProfileHash}/doc.bin`;
    mockFiles.set(fileHist, fileBytes);
    mockFiles.set(fileSrc, encoder.encode('tr'));

    await prepareIncomingHistoryFile({
      type: 'File',
      text: 'doc.bin',
      hasData: true,
      fileName: 'doc.bin',
      fileUri: fileSrc,
      fileSize: fileBytes.byteLength,
      profileHash: fileProfileHash,
      localClipboardHash: fileProfileHash,
    });
    expect(mockFiles.get(fileHist)).toEqual(fileBytes);

    const imageBytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const imageHash = sha256(imageBytes).toUpperCase();
    const imageProfileHash = sha256(`pic.png|${imageHash}`).toUpperCase();
    const imageSrc = 'file:///cache/.incoming_transfer/s1/pic.png';
    const imageHist = `file:///documents/clipboards/history/Image-${imageProfileHash}/pic.png`;
    mockFiles.set(imageHist, imageBytes);
    mockFiles.set(imageSrc, new Uint8Array([1]));

    await prepareIncomingHistoryFile({
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
    const groupHash = 'B'.repeat(64);
    const groupSrc = 'file:///cache/temp_files/File_2.zip';
    const groupHist = `file:///documents/clipboards/history/Group-${groupHash}/File_2.zip`;
    mockFiles.set(groupHist, zipBytes);
    mockFiles.set(groupSrc, new Uint8Array([80, 75]));

    await prepareIncomingHistoryFile({
      type: 'Group',
      text: 'a.png\nb.png',
      hasData: true,
      fileName: 'File_2.zip',
      fileUri: groupSrc,
      fileSize: zipBytes.byteLength,
      profileHash: groupHash,
      localClipboardHash: groupHash,
    });
    expect(mockFiles.get(groupHist)).toEqual(zipBytes);
    expect(nativeReplaceFile).not.toHaveBeenCalled();
  });

  it('在真实隔离磁盘目录中保留 19 字节正确历史文件并原子修复损坏历史文件', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'history-service-real-'));
    const historyRoot = path.join(tempRoot, 'history');
    const tempDir = path.join(tempRoot, 'temp');
    fs.mkdirSync(historyRoot, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });

    const prevFileImpl = (File as unknown as jest.Mock).getMockImplementation();
    const prevCopyImpl = (nativeCopyFile as jest.Mock).getMockImplementation();
    const prevReplaceImpl = (nativeReplaceFile as jest.Mock).getMockImplementation();
    const prevCalcHashImpl = jest.mocked(calculateFileHash).getMockImplementation();
    const prevGetHistImpl = jest.mocked(getHistoryFileUri).getMockImplementation();
    const prevPrepHistImpl = jest.mocked(prepareHistoryFileUri).getMockImplementation();

    try {
      (File as unknown as jest.Mock).mockImplementation((uri: string) => {
        const filePath = fileURLToPath(uri);
        return {
          uri,
          get exists() {
            return fs.existsSync(filePath);
          },
          get size() {
            return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
          },
          info: () =>
            fs.existsSync(filePath)
              ? { exists: true, size: fs.statSync(filePath).size }
              : { exists: false, size: 0 },
          delete: () => {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          },
        };
      });

      (nativeCopyFile as jest.Mock).mockImplementation(async (srcUri: string, destUri: string) => {
        const destPath = fileURLToPath(destUri);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(fileURLToPath(srcUri), destPath);
      });

      (nativeReplaceFile as jest.Mock).mockImplementation(
        async (srcUri: string, destUri: string) => {
          const destPath = fileURLToPath(destUri);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.renameSync(fileURLToPath(srcUri), destPath);
        }
      );

      jest.mocked(calculateFileHash).mockImplementation(async (uri: string) => {
        const bytes = fs.readFileSync(fileURLToPath(uri));
        return sha256(bytes).toUpperCase();
      });

      jest
        .mocked(getHistoryFileUri)
        .mockImplementation(async (type: string, profileHash: string, fileName: string) => {
          const candidate = path.join(historyRoot, `${type}-${profileHash}`, fileName);
          return fs.existsSync(candidate) ? pathToFileURL(candidate).toString() : null;
        });

      jest
        .mocked(prepareHistoryFileUri)
        .mockImplementation(async (type: string, profileHash: string, fileName: string) => {
          const candidate = path.join(historyRoot, `${type}-${profileHash}`, fileName);
          fs.mkdirSync(path.dirname(candidate), { recursive: true });
          return pathToFileURL(candidate).toString();
        });

      const validText = '1234567890123456789';
      const validBytes = encoder.encode(validText);
      const validHash = sha256(validBytes).toUpperCase();
      const fileName = `${validHash}.txt`;
      const histDir = path.join(historyRoot, `Text-${validHash}`);
      fs.mkdirSync(histDir, { recursive: true });
      const histPath = path.join(histDir, fileName);
      const srcPath = path.join(tempDir, fileName);

      // 1) 19 字节完好历史 + 3 字节截断临时源 -> 原样保留 19 字节
      fs.writeFileSync(histPath, validBytes);
      fs.writeFileSync(srcPath, encoder.encode('123'));

      const saved = await prepareIncomingHistoryFile({
        type: 'Text',
        text: validText,
        hasData: true,
        fileName,
        fileUri: pathToFileURL(srcPath).toString(),
        fileSize: validBytes.byteLength,
        profileHash: validHash,
        localClipboardHash: validHash,
      });

      expect(saved.fileUri).toBe(pathToFileURL(histPath).toString());
      expect(new Uint8Array(fs.readFileSync(histPath))).toEqual(validBytes);

      // 2) 历史副本损坏 -> 原子修复并清理所有 .tmp 暂存文件
      fs.writeFileSync(histPath, encoder.encode('corrupt'));
      fs.writeFileSync(srcPath, validBytes);

      await prepareIncomingHistoryFile({
        type: 'Text',
        text: validText,
        hasData: true,
        fileName,
        fileUri: pathToFileURL(srcPath).toString(),
        fileSize: validBytes.byteLength,
        profileHash: validHash,
        localClipboardHash: validHash,
      });

      expect(new Uint8Array(fs.readFileSync(histPath))).toEqual(validBytes);
      expect(fs.readdirSync(histDir)).toEqual([fileName]);

      // 3) 历史副本损坏且替换失败 -> 原损坏文件仍在磁盘上，且不残留 .tmp 文件
      const staleCorrupt = encoder.encode('stale-corrupt');
      fs.writeFileSync(histPath, staleCorrupt);
      (nativeReplaceFile as jest.Mock).mockRejectedValueOnce(new Error('disk full'));

      await expect(
        prepareIncomingHistoryFile({
          type: 'Text',
          text: validText,
          hasData: true,
          fileName,
          fileUri: pathToFileURL(srcPath).toString(),
          fileSize: validBytes.byteLength,
          profileHash: validHash,
          localClipboardHash: validHash,
        })
      ).rejects.toThrow('disk full');

      expect(new Uint8Array(fs.readFileSync(histPath))).toEqual(staleCorrupt);
      expect(fs.readdirSync(histDir)).toEqual([fileName]);
    } finally {
      (File as unknown as jest.Mock).mockImplementation(prevFileImpl);
      (nativeCopyFile as jest.Mock).mockImplementation(prevCopyImpl);
      (nativeReplaceFile as jest.Mock).mockImplementation(prevReplaceImpl);
      if (prevCalcHashImpl) jest.mocked(calculateFileHash).mockImplementation(prevCalcHashImpl);
      if (prevGetHistImpl) jest.mocked(getHistoryFileUri).mockImplementation(prevGetHistImpl);
      if (prevPrepHistImpl) jest.mocked(prepareHistoryFileUri).mockImplementation(prevPrepHistImpl);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

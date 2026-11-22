import { downloadForStorage } from '@/services/client/StorageClient';
import { historyService } from '@/services/history/HistoryService';
import { getAPIClient } from '@/services/ClientFactory';
import { calculateFileHash } from '@/utils/hash';

jest.mock('@/services/ClientFactory', () => ({ getAPIClient: jest.fn() }));
jest.mock('@/services/history/HistoryService', () => ({
  historyService: { getItem: jest.fn(), addItem: jest.fn() },
}));
jest.mock('@/utils/hash', () => ({
  calculateFileHash: jest.fn(),
  calculateFileProfileHash: jest.fn().mockResolvedValue('file-name-based-hash'),
}));
jest.mock('@/utils/fileStorage', () => ({
  prepareTempFilePath: (name: string) => `file:///temp/${name}`,
}));

test('storage downloads persist and return an image byte hash without changing profile identity', async () => {
  jest.mocked(historyService.getItem).mockResolvedValue(null);
  const downloadFile = jest.fn().mockResolvedValue('file:///temp/photo.png');
  jest
    .mocked(getAPIClient)
    .mockResolvedValue({ downloadFile } as unknown as Awaited<ReturnType<typeof getAPIClient>>);
  jest.mocked(calculateFileHash).mockResolvedValue('image-bytes');
  const result = await downloadForStorage({
    type: 'Image',
    text: 'photo.png',
    fileName: 'photo.png',
    profileHash: 'remote-profile',
    hasData: true,
  });
  expect(result).toMatchObject({
    profileHash: 'remote-profile',
    localClipboardHash: 'image-bytes',
  });
  expect(historyService.addItem).toHaveBeenCalledWith(
    expect.objectContaining({
      profileHash: 'remote-profile',
      localClipboardHash: 'image-bytes',
    })
  );
});

test('远端长文本缺少 hash 时以完整文件字节建立文本身份', async () => {
  const uri = 'file:///temp/document.txt';
  const downloadFile = jest.fn().mockResolvedValue(uri);
  jest
    .mocked(getAPIClient)
    .mockResolvedValue({ downloadFile } as unknown as Awaited<ReturnType<typeof getAPIClient>>);
  jest.mocked(historyService.getItem).mockResolvedValue(null);
  jest.mocked(calculateFileHash).mockResolvedValue('full-text-hash');
  const result = await downloadForStorage({
    type: 'Text',
    text: 'preview',
    fileName: 'document.txt',
    hasData: true,
  });
  expect(result).toMatchObject({
    profileHash: 'full-text-hash',
    localClipboardHash: 'full-text-hash',
    fileUri: uri,
  });
  expect(historyService.addItem).toHaveBeenCalledWith(
    expect.objectContaining({ profileHash: 'full-text-hash', localClipboardHash: 'full-text-hash' })
  );
});

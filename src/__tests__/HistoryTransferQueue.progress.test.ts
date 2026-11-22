import { calculateFileHash } from '../utils/hash';

jest.mock('../utils/hash', () => ({
  calculateFileHash: jest.fn().mockResolvedValue('image-bytes'),
}));

import { HistoryTransferQueue } from '../services/history/HistoryTransferQueue';
import type { TransferTask } from '../services/history/HistoryTransferQueue';
import type { IHistoryAPI } from '../api/history';
import { DownloadSizeLimitExceededError } from '../errors';
import { createHistoryItem } from '../types/clipboard';
import type { ClipboardContent } from '../types/clipboard';
import type { ProgressDetail } from '../types/progress';

jest.mock('../storage/HistoryStorage', () => ({
  HistoryStorage: { getInstance: () => mockStorage },
}));
jest.mock('../utils/fileStorage', () => ({
  getHistoryFileDir: () => ({ uri: 'file://history', exists: true }),
}));
jest.mock('../utils/clipboard/convert', () => ({
  historyItemToContent: (item: { type: string; profileHash: string }) => ({
    type: item.type,
    profileHash: item.profileHash,
  }),
  historyItemToDto: jest.fn(),
}));
jest.mock('expo-file-system', () => ({
  File: jest.fn((dir: { uri: string }, name: string) => ({
    uri: `${dir.uri}/${name}`,
    size: 12,
    exists: true,
  })),
}));

const mockStorage = { getItem: jest.fn(), updateItem: jest.fn().mockResolvedValue(undefined) };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

async function download(
  size: number | undefined,
  info: ProgressDetail,
  type: ClipboardContent['type'] = 'Image'
) {
  mockStorage.getItem.mockResolvedValue(
    createHistoryItem({
      type,
      profileHash: 'hash',
      text: 'download',
      hasData: true,
      dataName: 'data',
      size,
      timestamp: 0,
    })
  );
  const downloadData = jest.fn<
    ReturnType<IHistoryAPI['downloadData']>,
    Parameters<IHistoryAPI['downloadData']>
  >(async (_profileId, uri, _signal, report) => {
    report?.(info);
    return uri;
  });
  const queue = new HistoryTransferQueue();
  queue.setHistoryAPI({ downloadData } as unknown as IHistoryAPI);
  const snapshots: TransferTask[] = [];
  queue.onTaskStatusChanged((task) => snapshots.push({ ...task }));
  const report = jest.fn();
  const result = await queue.executeImmediateDownload(
    {
      type,
      profileHash: 'hash',
      text: 'download',
      hasData: true,
    },
    report
  );
  expect(result.fileUri).toBe('file://history/data');
  expect(queue.getActiveCount()).toBe(0);
  expect(snapshots.at(-1)?.status).toBe('completed');
  return {
    result,
    task: snapshots.find((task) => task.status === 'running' && task.bytesTransferred > 0)!,
    report,
  };
}

it.each(['Image', 'File'] as const)(
  '下载 %s 缺少响应长度时，用记录大小计算队列和外部回调进度',
  async (type) => {
    const { task, report } = await download(
      32768,
      {
        bytesTransferred: 8192,
        totalBytes: -1,
        progress: -1,
      },
      type
    );
    expect(task).toMatchObject({ bytesTransferred: 8192, totalBytes: 32768, progress: 25 });
    expect(report).toHaveBeenCalledWith({
      bytesTransferred: 8192,
      totalBytes: 32768,
      progress: 0.25,
    });
  }
);

it('响应提供总长度时优先使用，不使用记录大小', async () => {
  const { task, report } = await download(32768, {
    bytesTransferred: 8192,
    totalBytes: 16384,
    progress: 0.5,
  });
  expect(task).toMatchObject({ totalBytes: 16384, progress: 50 });
  expect(report).toHaveBeenCalledWith({ bytesTransferred: 8192, totalBytes: 16384, progress: 0.5 });
});

it.each([undefined, 0, -1, NaN, Infinity])(
  '记录大小为 %s 且缺少响应长度时保留未知进度',
  async (size) => {
    const { task, report } = await download(size, {
      bytesTransferred: 8192,
      totalBytes: -1,
      progress: -1,
    });
    expect(task.progress).toBe(-1);
    expect(report.mock.calls[0][0].progress).toBe(-1);
  }
);

it('记录大小小于实际传输大小时，进度不超出 100%', async () => {
  const { task, report } = await download(4096, {
    bytesTransferred: 8192,
    totalBytes: -1,
    progress: -1,
  });
  expect(task.progress).toBe(100);
  expect(report.mock.calls[0][0].progress).toBe(1);
});

it('keeps early image downloads pending until the history API is bound, then drains them', async () => {
  jest.useFakeTimers();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockStorage.getItem.mockResolvedValue(
    createHistoryItem({
      type: 'Image',
      profileHash: 'early',
      timestamp: 100,
      text: 'image',
      hasData: true,
      dataName: 'image.png',
    })
  );
  const queue = new HistoryTransferQueue();
  const states: string[] = [];
  queue.onTaskStatusChanged((task) => states.push(task.status));
  await queue.start();
  const task = await queue.addDownloadTask('Image-early');
  void task.awaiter.catch(() => {});
  try {
    await jest.advanceTimersByTimeAsync(5000);
    expect(task.status).toBe('pending');
    expect(task.failureCount).toBe(0);
    expect(states).not.toContain('failed');
    const downloadData = jest.fn().mockResolvedValue('file://history/image.png');
    queue.setHistoryAPI({ downloadData } as unknown as IHistoryAPI);
    await jest.advanceTimersByTimeAsync(0);
    await expect(task.awaiter).resolves.toMatchObject({ fileUri: 'file://history/image.png' });
    expect(downloadData).toHaveBeenCalledTimes(1);
  } finally {
    await queue.stop();
    jest.useRealTimers();
  }
});

it('downloaded images retain a byte hash in storage and returned content', async () => {
  const { result } = await download(12, { bytesTransferred: 12, totalBytes: 12, progress: 1 });
  expect(calculateFileHash).toHaveBeenCalledWith('file://history/data', expect.any(AbortSignal));
  expect(mockStorage.updateItem).toHaveBeenCalledWith('hash', {
    fileUri: 'file://history/data',
    localClipboardHash: 'image-bytes',
  });
  expect(result.localClipboardHash).toBe('image-bytes');
});

it('forwards maxBytes to historyAPI.downloadData and aborts without retrying on limit exceeded', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockStorage.getItem.mockResolvedValue(
    createHistoryItem({
      type: 'Text',
      profileHash: 'limited-text',
      timestamp: 100,
      text: 'preview',
      hasData: true,
      dataName: 'limited.txt',
      size: 2_000_000,
    })
  );

  const downloadData = jest.fn(async (_pid, uri) => uri);
  const queue = new HistoryTransferQueue({ retryDelayMs: 10 });
  queue.setHistoryAPI({ downloadData } as unknown as IHistoryAPI);

  await queue.executeImmediateDownload(
    {
      type: 'Text',
      profileHash: 'limited-text',
      text: 'preview',
      hasData: true,
      fileName: 'limited.txt',
    },
    undefined,
    undefined,
    5 * 1024 * 1024
  );
  expect(downloadData).toHaveBeenCalledWith(
    'Text-limited-text',
    'file://history/limited.txt',
    expect.any(AbortSignal),
    expect.any(Function),
    5 * 1024 * 1024
  );

  jest.clearAllMocks();
  const limitError = new DownloadSizeLimitExceededError('Download size (6000000) exceeds limit');
  const failingDownload = jest.fn().mockRejectedValue(limitError);
  queue.setHistoryAPI({ downloadData: failingDownload } as unknown as IHistoryAPI);
  const snapshots: TransferTask[] = [];
  queue.onTaskStatusChanged((task) => snapshots.push({ ...task }));

  await expect(
    queue.executeImmediateDownload(
      {
        type: 'Text',
        profileHash: 'limited-text',
        text: 'preview',
        hasData: true,
        fileName: 'limited.txt',
      },
      undefined,
      undefined,
      5 * 1024 * 1024
    )
  ).rejects.toThrow(DownloadSizeLimitExceededError);

  expect(mockStorage.updateItem).not.toHaveBeenCalled();
  expect(snapshots.every((t) => t.status !== 'waitForRetry' && t.failureCount === 0)).toBe(true);
  expect(queue.getPendingCount()).toBe(0);
  expect(queue.getActiveCount()).toBe(0);
});

it.each([10, 12])('共享手动下载时，限额 %i 的调用者独立检查实际文件大小', async (limit) => {
  const content = { type: 'Text' as const, profileHash: 'hash', text: 'preview', hasData: true };
  mockStorage.getItem.mockResolvedValue(createHistoryItem({ ...content, timestamp: 0 }));
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const downloadData = jest.fn(async (_pid, uri) => {
    await gate;
    return uri;
  });
  const queue = new HistoryTransferQueue();
  queue.setHistoryAPI({ downloadData } as unknown as IHistoryAPI);
  const manual = queue.executeImmediateDownload(content);
  await Promise.resolve();
  const limited = queue.executeImmediateDownload(content, undefined, undefined, limit);
  finish();
  await expect(manual).resolves.toMatchObject({ fileUri: 'file://history/data' });
  if (limit < 12) await expect(limited).rejects.toThrow(DownloadSizeLimitExceededError);
  else await expect(limited).resolves.toMatchObject({ fileUri: 'file://history/data' });
  expect(downloadData).toHaveBeenCalledTimes(1);
});

// 历史页只等待入队，任务被取消时可能没有调用者订阅 awaiter。
it.each(['download', 'upload'] as const)('排队的 %s 任务取消后允许稍后观察拒绝', async (type) => {
  const queue = new HistoryTransferQueue();
  const id = 'Text-hash';
  const task = await (type === 'download' ? queue.addDownloadTask(id) : queue.addUploadTask(id));
  expect(queue.cancelTask(id, type)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(task.awaiter).rejects.toThrow('Task cancelled');
  expect(queue.getPendingCount()).toBe(0);
});

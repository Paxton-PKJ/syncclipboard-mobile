import type {
  HistoryDragErrorCode,
  HistoryDragItem,
  HistoryDragRequest,
  HistoryGestureSurfaceHandle,
  HistorySelectionGesture,
} from 'native-util';
import type { HistoryItem } from '@/types/clipboard';

/** 历史拖拽整组校验失败，沿用原生业务错误码。 */
export class HistoryDragSelectionError extends Error {
  constructor(
    public code: HistoryDragErrorCode,
    public itemId?: string
  ) {
    super(code);
  }
}

/** 以手势开始前的选择为基线重算当前范围，回拖撤销本轮范围外的新增项。 */
export function extendRangeSelection(
  baselineIds: ReadonlySet<string>,
  visibleIds: readonly string[],
  anchorIndex: number,
  targetIndex: number
): Set<string> {
  const result = new Set(baselineIds);
  if (
    anchorIndex < 0 ||
    targetIndex < 0 ||
    anchorIndex >= visibleIds.length ||
    targetIndex >= visibleIds.length
  )
    return result;
  for (
    let index = Math.min(anchorIndex, targetIndex);
    index <= Math.max(anchorIndex, targetIndex);
    index++
  )
    result.add(visibleIds[index]);
  return result;
}

/** 从同一完整快照按 Set 顺序生成 payload，任何失效项使整组失败。 */
export function buildHistoryDragItems(
  items: readonly HistoryItem[],
  selectedIds: ReadonlySet<string>
): HistoryDragItem[] {
  if (!selectedIds.size) throw new HistoryDragSelectionError('EMPTY_SELECTION');
  const byId = new Map(items.map((item) => [item.profileHash, item]));
  return [...selectedIds].map((id) => {
    const item = byId.get(id);
    if (!item || item.isDeleted) throw new HistoryDragSelectionError('ITEM_NOT_FOUND', id);
    if (item.type !== 'Image' && item.type !== 'Text')
      throw new HistoryDragSelectionError('UNSUPPORTED_ITEM', id);
    if (item.type === 'Text' && !item.hasData) return { id, kind: 'text', text: item.text };
    if (!item.fileUri) throw new HistoryDragSelectionError('ITEM_NOT_READY', id);
    return {
      id,
      kind: item.type === 'Image' ? 'image' : 'textFile',
      fileUri: item.fileUri,
      expectedSize: item.size,
    };
  });
}

export interface HistoryViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface ItemLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface HistorySelectionList {
  getLayout(index: number): ItemLayout | undefined;
  getFirstItemOffset(): number;
  getAbsoluteLastScrollOffset(): number;
  getChildContainerDimensions(): { width: number; height: number };
  scrollToOffset(options: {
    offset: number;
    animated: boolean;
    skipFirstItemOffset: boolean;
  }): void;
}

/** 将手势容器本地 dp 转换到 FlashList 内容坐标，布局缺失时不估算。 */
export function findHistoryDragIndex(
  x: number,
  y: number,
  viewport: HistoryViewport,
  absoluteOffset: number,
  firstItemOffset: number,
  count: number,
  getLayout: (index: number) => ItemLayout | undefined
): number | undefined {
  if (x < viewport.x || x > viewport.x + viewport.width || viewport.height <= 0) return undefined;
  const contentY =
    Math.max(viewport.y, Math.min(y, viewport.y + viewport.height - 0.01)) -
    viewport.y +
    absoluteOffset -
    firstItemOffset;
  for (let index = 0; index < count; index++) {
    const layout = getLayout(index);
    if (layout && contentY >= layout.y && contentY < layout.y + layout.height) return index;
  }
  return undefined;
}

/** 48dp 边缘线性加速，上下边缘外仍以最大速度延伸。 */
export function historyEdgeVelocity(y: number, top: number, height: number): number {
  const edge = Math.min(48, height / 2);
  if (edge <= 0) return 0;
  if (y < top + edge) return -800 * Math.min(1, (top + edge - y) / edge);
  if (y > top + height - edge) return 800 * Math.min(1, (y - top - height + edge) / edge);
  return 0;
}

/** 给 UI 展示本地化错误，取消无需提示。 */
export function historyDragErrorMessage(code: HistoryDragErrorCode) {
  if (code === 'CANCELLED') return undefined;
  if (code === 'UNSUPPORTED_ITEM') return 'history.dragUnsupported';
  if (code === 'ITEM_NOT_FOUND') return 'history.dragMissing';
  if (
    code === 'ITEM_NOT_READY' ||
    code === 'INVALID_IMAGE' ||
    code === 'INVALID_TEXT' ||
    code === 'SOURCE_CHANGED'
  )
    return 'history.dragNotReady';
  if (code === 'PAYLOAD_TOO_LARGE') return 'history.dragTooLarge';
  return 'history.dragFailed';
}

interface RangeSession {
  id: number;
  ids: readonly string[];
  anchor: number;
  baselineIds: ReadonlySet<string>;
  pointer: { x: number; y: number };
  viewport?: HistoryViewport;
  lastFrame?: number;
  direction?: number;
  requestedOffset?: number;
  lastCommandOffset?: number;
  viewportRequest: number;
}
export interface HistoryDragSelectionDeps {
  getSnapshot(): { items: readonly HistoryItem[]; selectedIds: ReadonlySet<string> };
  getVisibleIds(): readonly string[];
  getList(): HistorySelectionList | null;
  getSurface(): HistoryGestureSurfaceHandle | null;
  measureViewport(callback: (viewport: HistoryViewport) => void): void;
  select(ids: Set<string>): void;
  enterMultiSelect(): void;
  onRangeActive(active: boolean): void;
  onError(code: HistoryDragErrorCode): void;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(id: number): void;
}

/** 列表级手势会话；不依赖任何可被回收的源卡片。 */
export class HistoryDragSelectionController {
  private range?: RangeSession;
  private frame?: number;
  private generation = 0;
  private requested = new Set<number>();

  constructor(private deps: HistoryDragSelectionDeps) {}

  selection(event: HistorySelectionGesture): void {
    if (event.phase === 'start') {
      this.stopRange();
      this.requested.add(event.gestureId);
      const ids = [...this.deps.getVisibleIds()];
      const anchor = ids.indexOf(event.sourceId);
      if (anchor < 0) {
        this.cancel();
        return;
      }
      const session: RangeSession = {
        id: event.gestureId,
        ids,
        anchor,
        baselineIds: new Set(this.deps.getSnapshot().selectedIds),
        pointer: { x: event.x, y: event.y },
        viewportRequest: 0,
      };
      this.range = session;
      this.deps.enterMultiSelect();
      this.deps.select(extendRangeSelection(session.baselineIds, ids, anchor, anchor));
      this.deps.onRangeActive(true);
      this.onViewportChanged();
    } else if (this.range?.id === event.gestureId) {
      if (event.phase === 'end' || event.phase === 'cancel') this.stopRange();
      else {
        this.range.pointer = { x: event.x, y: event.y };
        const viewport = this.range.viewport;
        if (
          viewport &&
          Math.sign(historyEdgeVelocity(event.y, viewport.y, viewport.height)) !==
            this.range.direction
        ) {
          this.range.direction = undefined;
          this.range.requestedOffset = undefined;
        }
        this.hitTest();
      }
    }
  }

  private hitTest(): void {
    const session = this.range;
    const list = this.deps.getList();
    if (!session?.viewport || !list) return;
    const index = findHistoryDragIndex(
      session.pointer.x,
      session.pointer.y,
      session.viewport,
      list.getAbsoluteLastScrollOffset(),
      list.getFirstItemOffset(),
      session.ids.length,
      (i) => list.getLayout(i)
    );
    if (index === undefined) return;
    const selected = this.deps.getSnapshot().selectedIds;
    const next = extendRangeSelection(session.baselineIds, session.ids, session.anchor, index);
    if (next.size !== selected.size || [...next].some((id) => !selected.has(id)))
      this.deps.select(next);
  }

  /** 容器布局变化时重新测量窗口坐标；忽略旧会话或较早的异步测量。 */
  onViewportChanged(): void {
    const session = this.range;
    if (!session) return;
    const request = ++session.viewportRequest;
    this.deps.measureViewport((viewport) => {
      if (this.range !== session || request !== session.viewportRequest) return;
      session.viewport = viewport;
      this.hitTest();
      this.scheduleFrame();
    });
  }

  private scheduleFrame(): void {
    const session = this.range;
    if (!session || this.frame !== undefined) return;
    this.frame = this.deps.requestFrame((time) => {
      if (this.range !== session) return;
      this.frame = undefined;
      const list = this.deps.getList();
      if (!session.viewport || !list) return;
      const dt =
        session.lastFrame === undefined ? 0 : Math.max(0, Math.min(32, time - session.lastFrame));
      session.lastFrame = time;
      const velocity = historyEdgeVelocity(
        session.pointer.y,
        session.viewport.y,
        session.viewport.height
      );
      const maxOffset = Math.max(
        0,
        list.getChildContainerDimensions().height +
          list.getFirstItemOffset() -
          session.viewport.height
      );
      const current = list.getAbsoluteLastScrollOffset();
      const direction = Math.sign(velocity);
      if (direction !== session.direction || session.requestedOffset === undefined) {
        session.direction = direction;
        session.requestedOffset = current;
      }
      // 目标由本会话积分，滞后或重复的 onScroll 不得把下一帧目标拉回。
      const base =
        direction > 0
          ? Math.max(session.requestedOffset, current)
          : Math.min(session.requestedOffset, current);
      const offset = Math.max(0, Math.min(maxOffset, base + (velocity * dt) / 1000));
      session.requestedOffset = direction ? offset : undefined;
      if (velocity && offset !== current && offset !== session.lastCommandOffset) {
        list.scrollToOffset({ offset, animated: false, skipFirstItemOffset: true });
        session.lastCommandOffset = offset;
      }
      // 命令尚未被原生执行时，选区仍只能使用列表实际观测到的位置。
      this.hitTest();
      this.scheduleFrame();
    });
  }

  onScroll(): void {
    this.hitTest();
  }

  private stopRange(): void {
    if (this.frame !== undefined) this.deps.cancelFrame(this.frame);
    this.frame = undefined;
    if (this.range) this.deps.onRangeActive(false);
    this.range = undefined;
  }

  /** 失焦/筛选变化取消未启动准备，原生保留已启动的跨应用 drag。 */
  cancel(): void {
    this.generation++;
    this.stopRange();
    void this.deps
      .getSurface()
      ?.cancelGesture()
      .catch(() => {});
  }

  async drag(event: HistoryDragRequest): Promise<void> {
    if (this.range || this.requested.has(event.gestureId)) return;
    this.requested.add(event.gestureId);
    const generation = this.generation;
    try {
      const snapshot = this.deps.getSnapshot();
      if (!snapshot.selectedIds.has(event.sourceId))
        throw new HistoryDragSelectionError('CANCELLED');
      const payload = buildHistoryDragItems(snapshot.items, snapshot.selectedIds);
      const surface = this.deps.getSurface();
      if (!surface) throw new HistoryDragSelectionError('UNAVAILABLE');
      const result = await surface.startDrag(event.gestureId, payload);
      if (generation === this.generation && !result.started) {
        this.deps.onError(result.code);
        this.cancel();
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.deps.onError(error instanceof HistoryDragSelectionError ? error.code : 'START_FAILED');
      this.cancel();
    }
  }
}

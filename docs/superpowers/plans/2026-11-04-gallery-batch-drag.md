# Gallery Selection and Batch Drag Implementation Plan

> **For agentic workers:** Execute the three tasks below with the repository's prescribed `sol` workers. Do not delegate further. The user has authorized implementation; no additional plan confirmation is required.

**Goal:** 历史记录支持长按连续范围选择、回拖收缩、边缘滚动，以及松手后二次长按已选项拖出全部图片和完整文本；首页本地图片复用现有单图拖拽，并支持拖出完整文本。

**Architecture:** Android 原生统一识别历史长按和系统拖拽，JS 管理范围选择、列表定位及自动滚动。稳定的列表级 `HistoryGestureSurface` 观察触摸，卡片级 `HistoryDragSource` 只标记 sourceId/mode，避免 FlashList 回收起始卡片中断持续增选。保留现有 `ImageDragSource` API 和 Fabric 测量修复。

**Tech Stack:** Expo SDK 55、RN 0.83.2、FlashList 2.0.2、现有 native-util；无新增依赖。

**Spec:** 本文“用户约定”记录本次已确认的交互要求。

## 用户约定与约束

- 普通态首次长按进入多选并选中当前项；同一轮手势到 up/cancel 始终属于范围选择，不能因 React 状态变化启动 drag。
- 保持按住上下移动，选择为“手势开始前的 selectedIds 基线 ∪ 起点到当前位置的连续范围”。反向回拖撤销本轮范围外的新增项，越过起点后改选另一侧；手势前已选项（含当前筛选隐藏项）始终保留。边缘自动滚动按实际列表位置更新范围。
- 松手后，多选态长按任意已选项拖出全部 selectedIds；长按未选项继续范围增选；短按切换该项 selected。
- File/Group 允许选择；批量拖拽只支持 Image/Text，任意不支持、缺失、未下载、失效项都使整组明确失败，禁止过滤后拖剩余项。
- 从 `useHistoryStore.getState().items` 映射整个 selectedIds，不能只取当前分类。按 Set 插入顺序输出，缺少任一 ID 即失败；搜索后不在 items 的旧选择同样明确失败。
- 拖拽请求时一次性复制整组数据；准备完成前不启动系统 drag，不因重新渲染重复准备。取消、卸载、失焦、切换筛选或数据失效均废弃尚未启动的准备/选择 session；已经启动的 global drag 必须继续跨应用投递，URI 保留窗口不能因此被撤销。
- Text.hasData 为 true 必须从 fileUri 读取完整 UTF-8，不能使用预览 text；其他 Text 使用 text 原文。
- 首页不新增多选或把手；本地/远程图片复用现有 ImageDragSource 和失败提示。本地已加载图片及完整文本在上传期间仍可拖出，远程内容传输期间保持禁用；hasData 文本读取完整 UTF-8 文件。非 Android 安全回退普通 View/现有选择行为。
- 不回退 ImageDragSourceView 的 onMeasure 自测量和 onLayout no-op；新 Expo 包装 View 采用相同约束。保留嵌套按钮短按、普通列表滚动和 Tab 切换。

## 已核实的本地 API

- `node_modules/@shopify/flash-list/src/FlashListRef.ts` 提供 `getLayout(index): {x,y,width,height}|undefined`、`getFirstItemOffset()`、`getAbsoluteLastScrollOffset()`、`getChildContainerDimensions()`、`getWindowSize()`、`scrollToOffset({offset, animated, skipFirstItemOffset})`。getLayout.y 不含 firstItemOffset。
- 用包裹列表的 RN View.measureInWindow 获取窗口坐标；native absoluteX/Y 必须将 rawX/rawY 转为 RN dp。同一坐标系下 `contentY = absoluteY - viewportTop + absoluteOffset - firstItemOffset`，以 getLayout 命中索引；布局未就绪时不猜索引。
- `expo-modules-core` 的 ModuleDefinitionBuilder 允许多个 View；第一个仍是默认 View。保留 ImageDragSourceView 第一项，再注册具名 HistoryGestureSurfaceView/HistoryDragSourceView；JS 使用 `requireNativeViewManager('NativeUtilModule', 'HistoryGestureSurfaceView')` 等第二参数。
- View 内 `AsyncFunction` 自动绑定 view owner 且在 MAIN 队列执行；JS adapter 将 ViewPrototypes 方法挂到 ref。包装组件使用 forwardRef 暴露下述 handle，IO 自行切换现有 executor。
- RN 提供 `NativeGestureUtil.notifyNativeGestureStarted/Ended`。原生长按激活时通知 RN 并取消子触摸，避免 Pressable 在释放时误触；仅取消 Android 子事件不足以保证 JS responder 取消。

## 固定接口（native worker 定义，UI worker 直接消费）

文件：`modules/native-util/src/HistoryGestureSurface.tsx` 和 `HistoryDragSource.tsx`，从 index.ts 导出。

```typescript
type HistoryGestureMode = 'select' | 'drag' | 'disabled';
type HistoryDragItem =
  | { id: string; kind: 'image'; fileUri: string; expectedSize?: number }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'textFile'; fileUri: string; expectedSize?: number };
type HistoryDragErrorCode =
  | 'EMPTY_SELECTION'
  | 'UNSUPPORTED_ITEM'
  | 'ITEM_NOT_FOUND'
  | 'ITEM_NOT_READY'
  | 'INVALID_IMAGE'
  | 'INVALID_TEXT'
  | 'SOURCE_CHANGED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNAVAILABLE'
  | 'START_FAILED'
  | 'CANCELLED'
  | 'BUSY';
type HistoryDragStartResult =
  | { started: true }
  | { started: false; code: HistoryDragErrorCode; itemId?: string };
interface HistoryGestureSurfaceHandle {
  startDrag(gestureId: number, items: HistoryDragItem[]): Promise<HistoryDragStartResult>;
  cancelGesture(): Promise<void>;
}
interface HistorySelectionGesture {
  gestureId: number;
  sourceId: string;
  phase: 'start' | 'move' | 'end' | 'cancel';
  absoluteX: number;
  absoluteY: number;
}
interface HistoryDragRequest {
  gestureId: number;
  sourceId: string;
}
interface HistoryDragEnd {
  gestureId: number;
  completed: boolean;
}
```

- 所有类型均 export。HistoryDragSourceProps extends ViewProps，增加必填 `sourceId: string`、`gestureMode: HistoryGestureMode`；仅呈现 children/元数据，不识别手势，不暴露 ref 方法。
- HistoryGestureSurfaceProps extends ViewProps，增加必填 `gestureEpoch: number`，可选 `enabled?: boolean`（默认 true）；三个回调为 `onSelectionGesture?: (event: NativeSyntheticEvent<HistorySelectionGesture>) => void`、`onDragRequested?: (event: NativeSyntheticEvent<HistoryDragRequest>) => void`、`onDragEnded?: (event: NativeSyntheticEvent<HistoryDragEnd>) => void`。ref 类型为上述 handle。
- surface 在 ACTION_DOWN 命中后代 marker，复制 sourceId 和 gestureMode 到本轮 session；500ms 内超过 Android touchSlop、第二指或父级取消则不激活。只有 surface 长按识别器决定 select/drag；UI 禁用 Android 原有 Pressable.onLongPress，不新增 RNGH 长按识别器。
- 长按前正常分发所有子事件；长按后 surface 接管本轮触摸并禁止父级常规拦截，select 发 start/move/end/cancel，drag 仅发一次 onDragRequested。marker 属性变化不改变本轮模式；select 中 marker 被 FlashList 回收也不结束 session。
- gestureEpoch 改变、surface 卸载/失焦取消尚未启动的准备/选择 session；本轮选中集合变化不递增 epoch。startDrag 只接受当前已激活 drag session，相同 session 第二次调用返回 BUSY，不重复创建快照。UP/CANCEL 在准备完成前取消；系统 drag 已启动后，触摸 CANCEL、epoch 改变、失焦或 detach 均不能终止跨应用投递或撤销 URI。detach 可释放 source 引用，但已启动快照继续保留 24h TTL。
- startDrag 的业务失败返回 union；桥接意外 rejection 也由 UI 捕获为 START_FAILED。UI 映射不支持/缺少项时使用相同 error code 提示并 cancelGesture。CANCELLED 静默，其他失败显示本地化错误，不显示技术 code。
- 所有图片准备为独立 content URI，保留 24h TTL；全项准备后按输入顺序创建 ClipData，文本为 `ClipData.Item(fullText)`，图片为 URI Item，description 为去重后的实际 image MIME 和 text/plain，flags 为 GLOBAL | GLOBAL_URI_READ。
- 完整文本 UTF-8 总字节上限固定 131072，最终 ClipData.writeToParcel 的 dataSize 上限 262144 字节；超过任一限制返回 PAYLOAD_TOO_LARGE，不能截断。textFile 有界读取并严格解码 UTF-8，检查来源 size/mtime 前后一致。
- 新增 ImageDragFileStore.discard(snapshot) 删除未启动拖拽的临时文件；prepare 保持原调用兼容，增加可选取消检查并在复制循环检查。组准备失败/取消时 discard 全部已准备文件；已经启动的 drag 结束后 release 保留接收端读取窗口。

## Review Focus

- 首次长按引起多选重渲染后仍只进行范围选择；二次长按已选项只发一个拖拽请求。
- 起始行滚出回收区后范围选择仍继续；反向移动撤销本轮范围外新增项并保留手势前基线。
- 跨分类选择含失效、未下载或 File/Group 时整组失败；不能漏项。
- hasData 文本远超预览长度、非 ASCII 文本、多张图片混合，目标端读取原文和每张图片。
- 取消准备、卸载、筛选/数据变化及大文本超限不遗留在途任务、不启动旧 payload。

## Task 1: Native gesture surface and mixed payload（native worker）

**Ownership:** 仅 `modules/native-util/**`，包括新增两种 View、`HistoryDragPayload.kt`、对应 TS 包装/导出及 `src/__tests__/historyDragBridge.test.tsx`；如需 native instrumentation，测试放 `android/src/androidTest/java/expo/modules/nativeutil/HistoryDragPayloadTest.kt`，只修改本模块 build.gradle，使用 Android 内置 InstrumentationTestRunner，不新增依赖。

**Consumes/Produces:** 完整实现上文固定接口；既有 ImageDragSource 兼容。

- [x] 桥接用例已覆盖具名 view 注册、ref 方法传参、非 Android 安全 View 回退；最终测试通过。首次 red 阶段输出未在最终验收中另行核实。
- [x] 实现 surface 的唯一长按状态机与 marker。验证 mode 固定、一次 request、普通按钮短按，以及 select 不依赖起始行存活。
- [x] 实现整组准备、完整文本、MIME/顺序、Parcel 限制及取消清理；instrumentation 断言混合 ClipData 的 itemCount/原文/URI 可读、准确边界、坏文件整组失败、取消无残留。保留旧单图测量/布局和 TTL。
- [x] 桥接测试、native debug/androidTest 构建和模拟器 instrumentation 已通过；首次整合 XML 为 6 tests、0 failures、0 errors，本轮最终为 8 tests。真实触摸补充验收见后文。
- [x] 原生任务已统一整合提交至 `3faeb259cee874de1db1cccdfbaab740a8a2d621`（`feat: add gallery selection and mixed clipboard drag`）。

## Task 2: History range selection and UI integration（UI worker）

**Ownership:** `src/screens/HistoryScreen.tsx`、`src/components/HistoryListItem.tsx`、新增 `src/screens/history/historyDragSelection.ts`、`src/__tests__/historyDragSelection.test.ts`、`src/__tests__/historyDragInteraction.test.tsx`、`src/i18n/locales/en.ts` 和 `src/i18n/locales/zh.ts`。不改 native-util、CurrentClipboardCard 或 store 公共接口。

**Consumes:** Task 1 导出接口。helper 在本 feature 内导出 `extendRangeSelection(baselineIds: ReadonlySet<string>, visibleIds: readonly string[], anchorIndex: number, targetIndex: number): Set<string>` 和 `buildHistoryDragItems(items: readonly HistoryItem[], selectedIds: ReadonlySet<string>): HistoryDragItem[]`；前者每次接收手势开始时复制的基线，后者失败抛带 code/itemId 的本地错误。UI 读取 selectedIds 与 items 的同一 store 快照后立即构建数组。

- [x] 测试覆盖基线与当前范围并集、反向收缩/越过起点、首次长按不 drag、二次一次 drag、跨分类全部 ID/稳定顺序、missing/File/Group/未下载失败、hasData 映射 textFile 且不传 preview。反向收缩及异步滚动修复的 red/green 记录见下文；最初实现的 red 输出未另行核实。
- [x] 实现 helper；每个 Tab 的列表包 stable surface，卡片包 marker。普通态 marker=select；多选态 selected=drag、unselected=select。保留原嵌套按钮和非 Android 选择路径。
- [x] start 冻结当前分类 ID 序列、anchor 和 selectedIds 基线，初始测量 viewport，容器布局变化时重新测量；进入多选后用 store.setState 重算范围，不 toggle。move 依据 FlashList 实际 layout 计算目标，持有 last pointer 并用 requestAnimationFrame 自动滚动；边缘区域 48dp，速度按深入程度从 0 线性增加到 800dp/s，dt 最大 32ms。滚动目标由本会话积分并按 viewport/content height 限界，不被滞后观测回写；命中始终使用实际 absolute offset 和 firstItemOffset，每帧及 onScroll 后重算，即使手指不动也继续选择。结束清理 RAF 并拒绝旧会话回调；scope 变化立即取消而不回滚已经选中的项。
- [x] Tab/search/sort、数据 ID/版本/URI/删除状态变化、退出多选、导航失焦递增 epoch 并清理范围；选择更新本身不取消。选择期间 FlashList.scrollEnabled=false、TabView.swipeEnabled=false，正常态恢复；禁用 maintainVisibleContentPosition 的自动位置调整以免干扰受控滚动。surface 不依赖 source 行存活；原生已启动 global drag 继续跨应用投递。
- [x] onDragRequested 同步取得完整 store 快照构建 payload，调用 surfaceRef.startDrag；映射失败调用 cancelGesture。添加 `history.dragUnsupported`、`dragMissing`、`dragNotReady`、`dragTooLarge`、`dragFailed` 的中英文提示，PAYLOAD_TOO_LARGE 明示完整文本超限。
- [x] 历史选择与批量拖拽任务已统一整合提交至 `3faeb259cee874de1db1cccdfbaab740a8a2d621`；用例和触摸按钮/取消已验证，物理行回收尚未单独 instrument 证明。

## Task 3: Home local image drag（home worker）

**Ownership:** 仅 `src/components/CurrentClipboardCard.tsx`、`src/__tests__/currentClipboardImageDrag.test.tsx`。不改 native-util、i18n 或历史文件。

**Consumes/Produces:** 沿用现有 ImageDragSourceProps，首页本地图片与远程图片使用相同 drag 条件。

- [x] 本地图片 onLoad 后可拖拽用例及非 Android、非图片、无 file URI、load error 的限制断言已通过。本轮补充验证本地上传期间仍可拖拽，远程传输期间禁用。首次 red 阶段输出未在最终验收中另行核实。
- [x] 去除仅远程可拖拽的限制，复用既有 source/提示，不新增手势、把手或多选。
- [x] 首页本地图片拖拽任务已统一整合提交至 `3faeb259cee874de1db1cccdfbaab740a8a2d621`，测试与真实 DROP 已通过。

## 整合验证与真实模拟器验收

- [x] 三任务已完成并整合。所有 workers 不是仓库独占者，不回退他人改动，不派生子代理。
- [x] TS/JS 最终统一执行 `npm run lint:fix` 后 `npm run type-check`，运行 `npm run test -- --runInBand`；JSON/Markdown 执行 `npm run format-docs`；检查 diff 排除无关自动修复/格式变化。未改 plugins，不需要 plugin:build。
- [x] Android 模拟器已安装本次 APK，并准备 48 条 fixture，保留原 3 条记录与配置备份；含图片、完整文本和 File/Group。
- [x] 旧版真实同 pointer 首次长按只选 1 项，移动后 2 → 7 → 30；边缘滚动至起点离屏继续，UP 后 2 秒画面稳定。该轮曾观察到反向不减选，此行为已由用户纠正为回拖收缩，不能作为当前约定的验收证据。短按 30 → 29；未选项长按增选；二次长按 2 条已选文本仅启动一次系统 drag，shadow 数量为 2。选择期间 BACK 退出，UP 后 2 秒稳定。
- [x] 外部 receiver 分屏真实收到跨分类 mixed drag 的 4 项，ACTION_DROP 权限获取成功，顺序、完整 Unicode/长文本及两张不同 MIME 图片的 hash 全部匹配；drop、5 秒、15 秒读取均成功。源应用失焦未取消已启动 global drag。
- [x] File/Group 整组明确失败已经真实触摸验证；缺失 ID、未下载、失效来源、文本/Parcel 边界和取消清理由 JS/native 测试覆盖。未将这些自动化用例表述为逐项真实触摸验收。
- [x] 首页本地图片真实 DROP 至 receiver 成功，drop、5 秒、15 秒均可读取；copy/favorite 短按及普通滚动未进入多选或拖拽。用户已确认远程图片上游真实拖拽正常。
- [x] 预览验收要求至少 1 cycle 的 A/B/C 连续更新；本次 1 cycle 为 PASS，尺寸见下文。先前 Fabric 修复已验证重启后重复，本轮未修改原测量/布局修复，因此最终验收采用本次 1 cycle；未声称本次执行 2 cycles。
- [ ] 云端 APK 构建尚待 fork PR 对应的新 head Actions 运行完成，不能记为已完成。
- [x] 仓库外保留 receiver 原始结果和验证输出；覆盖范围及未完成项见下文。无 fixture、receiver 工程或 APK 加入本仓库。

## 首次整合验收记录（2026-11-04；本轮最终结果见末节）

- 最终统一检查：`npm run lint:fix` → `npm run type-check` → `npm run test -- --runInBand` → `npm run format-docs` 全部 exit 0；58 suites、489 tests 全部通过。日志位于 `D:/Temp/gallery-final-{lint,type-check,test,format-docs}.log`；自动修复/格式化前后文件 SHA-256 对比无改动，`git diff --check` exit 0。旧 ImageDragSourceView 的 Fabric 自测量/no-op 布局保护原样保留，两种新增 Expo wrapper 同样具有保护。
- 整合提交：`3faeb259cee874de1db1cccdfbaab740a8a2d621`（`feat: add gallery selection and mixed clipboard drag`），包含上述三个任务的 23 个源代码/测试文件；计划文档另行提交。最终独立 review 未发现 P1/P2。
- Native instrumentation：`cd android && ./gradlew :native-util:connectedDebugAndroidTest` 已通过；最终 XML `modules/native-util/android/build/outputs/androidTest-results/connected/debug/TEST-Pixel_6(AVD) - 12-_native-util-.xml` 记录 `tests="6" failures="0" errors="0" skipped="0"`，时间戳 `2026-11-04T02:21:02`。其后的修改仅涉及测试输入的 ASCII Parcel 假设与 build.gradle 默认测试 class 过滤，生产代码未变；最终记录阶段读取最新 XML，不重复设备测试。
- 本地 release build 已成功；未执行云端 release/APK 发布，未将其记为完成。
- Mixed DROP 证据：`D:/Temp/gallery-drag-acceptance/drop-evidence/receiver-result.json`、`verification.txt`（`PASS`）。顺序为 inline Unicode 文本（78 UTF-16 / 111 UTF-8 bytes）、hasData 完整文本（59801 UTF-16 / 86973 UTF-8 bytes，含末尾独特标记）、PNG（2920 bytes）、JPEG（4964 bytes）。接收端得到全部 4 项，MIME 为 text/plain、image/png、image/jpeg，drop 与 +5/+15 秒的原文/字节/hash 均一致。
- 首页本地单图证据：同目录 `home-local-result.json` 的第 2 次 drop，PNG 2920 bytes，SHA-256 `7d59ca8034322125723d1ff1a1ea8b415097a08ed0a8d237b75acdb6ffb671c2`；drop 与 +5/+15 秒读取成功。
- 预览回归：验收要求至少 1 cycle 的 A/B/C 连续更新；现有脚本本次 1 cycle 为 PASS，A/B/C 未 resize 为 440354 / 440349 / 440349，resize 为 425388 / 425380 / 425383。先前 Fabric 修复已验证重启后重复且本轮原修复未动，本次按最终测试裁定满足预览验收；本次未执行 2 cycles。
- 清场：HTTP fixture 服务已停止，模拟器分辨率恢复 1080 × 2400，所有 pointer 已 UP；ADB reverse 8765 保留。
- 尚未覆盖：不能保证任意目标 app 支持 mixed ClipData；未单独 instrument 证明物理 row 回收，但真实边缘选择已到起点离屏且连续选中 30 项。逐项筛选/删除/触摸 cancel 的设备矩阵未全部单独运行，相关失效与取消由自动化覆盖。云端 APK 构建结果仍待 fork Actions 完成。

## CI 测试发现修复与构建前置验证（2026-11-04）

- 根因：CI 的 `npm ci` 会通过 workspace prepare 构建 native-util。模块原 `tsconfig.json` 包含整个 src，将桥接测试编译为 `build/__tests__/historyDragBridge.test.js` 和 `.d.ts`；Jest 的宽泛 `__tests__` 匹配同时发现源测试、编译后的 JS 和声明文件。声明文件没有测试而失败，编译后的 JS 重复执行两条用例。本地先执行 `npm run build --workspace=native-util` 后稳定复现：1 failed、59 passed、60 suites，491 tests passed；日志为 `D:/Temp/gallery-drag-acceptance/ci-local-unit-after-native-build.log`。
- 修复：native-util 构建保留原排除项，并排除 `src/__tests__`、`src/**/*.test.*` 与 `src/**/*.spec.*`；Jest 保留 node_modules 默认忽略，并忽略 `modules/*/build/` 生成目录，避免已有构建缓存或其他模块编译测试被重复发现。源桥接测试继续参与运行。
- 缓存回归：先仅修改 Jest 配置，保留旧 `build/__tests__` 产物运行原命令 `npm test`。首次运行源 SettingsScreen 用例触发既有 5000ms 超时（57 suites / 488 tests passed，1 failed）；发现数量已恢复为 58 suites / 489 tests。原命令重试 exit 0，58 suites、489 tests 全部通过，无编译测试重复执行。日志为 `ci-unit-stale-build-jest-fix.log` 与 `ci-unit-stale-build-jest-fix-retry.log`，均位于上述目录。
- 构建前置验收：验证真实绝对路径后，仅删除已知生成目录 `modules/native-util/build/__tests__`，保留其他 build 产物及源测试。执行 `npm run lint:fix` → `npm run type-check` → `npm run build --workspace=native-util` → `npm test` → `npm run test:coverage`，全部 exit 0；两次最终 Jest 运行均为 58 suites、489 tests passed，保持 CI 原命令，未添加 `--runInBand`。构建后目录仍无 `__tests__`；`npx jest --listTests --json` 确认恰好 58 条源测试路径，含源桥接测试且无 `modules/*/build/` 路径。
- 日志：`D:/Temp/gallery-drag-acceptance/ci-discovery-fix-{lint,type-check,native-build,test,coverage}.log`；发现列表为同目录 `ci-discovery-fix-list-tests.json`。本次只修改构建排除、Jest 配置和本文档，未修改 native/UI 生产行为；云端新 head 验证仍待后续运行。

## 范围回拖与异步边缘滚动修复（2026-11-04）

- 两个外部脚本直接加载实际 `HistoryDragSelectionController`，均在修复前 exit 1。`node D:/Temp/gallery-drag-acceptance/regression-evidence/delayed-scroll-controller.cjs` 使用不等高 `[80,170,110,240,90,360]`、固定底边 pointer、16/32ms 帧间隔及延迟/重复滚动观测，160ms 内命令为 `12.533 → 25.067 → 12.533 → 37.600 → 25.067 → 50.133 → 37.600`，存在 3 次目标回退。`node D:/Temp/gallery-drag-acceptance/regression-evidence/reverse-controller.cjs` 的 A → D → B 得到 `{base,A,B,C,D}`，正确结果应为 `{base,A,B}`。
- 仓库内先添加真实 controller 回归后运行两项 history 测试：7 failed、32 passed；修复后连同 viewport 变化/观测提前回归共 41 passed。覆盖基线复制、同数量换项、跨 anchor、异步旧观测、上下方向切换、离开/重进边缘、不重复边界命令、content/viewport 变化限界，以及 UP 后旧 RAF 不污染下一轮。
- 最小实现：每轮复制不可变选择基线；move/scroll 从基线与当前范围重算。每轮自行维护 requested offset，方向不变时按 dt 积分，旧观测不拉回目标，方向切换或离开边缘后从实际观测重新起算；命中仍使用实际 offset，不能把未执行的命令当作原生已到达的位置。保留原有 scope 取消、二次长按拖出、非 Android 及源卡片回收处理。
- 两个原始外部命令修后均 exit 0，脚本门槛未改。滚动命令为 `12.533 → 37.600 → 50.133 → 75.200 → 87.733 → 112.800 → 125.333`，回退为 0；A → D → B 最终为 `{base,A,B}`。
- 上述 red/green 阶段仅做定向 JS 验证；后续最终设备及构建结果见下节。原 screenrecord 约 3.9fps，不能据此声称滚动平滑。

## 本轮修复最终验收（2026-11-04）

- 范围选择根因：把本轮累计选择继续作为基线，导致反向回拖不收缩；异步旧滚动观测又反复覆盖下一帧目标，导致边缘滚动回退。最终实现使用手势前不可变基线与当前连续范围的并集、会话拥有的积分目标，并在容器布局变化后刷新 viewport；命中仍按实际列表位置计算。
- 首页根因：统一的 acting 禁用同时阻断了本地上传期间拖拽；URI 校验遗漏有效的 `file:/`，图片旧回调可能污染新内容；文本预览没有完整文本拖拽入口。现复用 native surface 拖出原始 inline 文本或 hasData 文件，按内容身份废弃旧回调/准备，保留远程传输禁用及非 Android 回退。
- 原生短按误拖根因：静态 Text 子 View 不处理 DOWN 时，surface 未保留 pending 触摸流，随后收不到 UP，500ms 定时激活成为 ghost drag。现先正常分发子事件，并为 pending session 保留事件流；真实短按等待 1.2 秒为 0 次 drag，长按为 1 次，已完成设备 red/green 验证。
- 文本元数据根因：`fileSize` 曾保存 JS UTF-16 字符数，而原生 expectedSize 校验使用文件字节数；缓存存在也不能证明内容完整。现以 UTF-8 buffer.byteLength 保存字节大小，独立可选 `textLength` 保存完整文本 UTF-16 长度供 UI 显示，复用历史/临时缓存前比较完整内容。旧 textFile 只有在元数据等于解码后字符数、ID 为 64 位十六进制且匹配完整文件 SHA-256 时才兼容；未放宽来源 size/mtime、严格 UTF-8、完整 hash、128KiB 文本或 Parcel 限制。
- 最终统一验证已在最后一次源代码修改后执行：`npm run lint:fix` → `npm run type-check` → `npm run build --workspace=native-util` → `npm test` → `npm run test:coverage` → `npm run format-docs` 全部通过。Jest 与 coverage 均为 60 suites、528 tests passed；`npx jest --listTests --json` 为 60 条源测试，无 `modules/*/build/`，`git diff --check` 通过。Native instrumentation 最新 XML 为 8 tests、0 failures、0 errors，含旧字符数元数据的真实正负用例。本节文档更新后仅补跑 format-docs 和 diff 检查。
- 最终本地 release build 用时 2m44s，APK 时间为 16:26:27，已实际安装并正常启动。设备旧 native 对照为 310 frames / 10.178s、16 次回退、最大 32px；新 warm 采样为 251 frames / 10.144s、0 次回退、0px。UP 后 102 frames / 2.170s offset 恒为 6008。反向范围为 1 → 3 → 2 → 1；保留手势前基线的检查为 1 → 2 → 4 → 3 → 2。环境旧采样约 31fps、新采样总计约 26.76fps，以上证明回退修复和 UP 停止，不能宣称 FPS 性能验收通过。
- 本地上传并拖出：外部 producer 提供新的 `content://` PNG（13,757 bytes）；source PUT 人为延迟 20 秒，`PUT_WAIT +8.867s` 截图仍显示上传中且已拖拽，receiver 在 DROP、+5、+15 秒的字节/hash 均一致。首页 inline 文本为 78 UTF-16 / 111 UTF-8 bytes，真实 DROP 成功；最终 hasData 文本为 59,801 UTF-16 / 86,973 UTF-8 bytes，完整末尾标记保留，DROP 与 +5 秒原文/hash 一致。
- 最终远程预览 A/B/C 连续更新 1 cycle、6/6 PASS，未 resize/resize 的有效像素为 425383–440358；未修改既有 Fabric 测量/布局修复。所有 pointer 已 UP，分辨率恢复 1080 × 2400 且无 override，自建服务均停止。
- 原始设备证据保留在仓库外 `D:/Temp/gallery-drag-acceptance/fixed-regressions/` 和 `scroll-probe/`。设备未找到旧 size=59801 的历史记录，legacy 兼容仅由 8 项真实 native instrumentation 中的相关正负用例覆盖，未声称 legacy UI 已通过。物理行回收及逐项触摸取消矩阵的限制沿用前述记录；不能保证任意目标 app 支持 mixed ClipData。外部 fixture、receiver、凭据、APK、生成构建和临时诊断均不入库。
- [ ] 本轮新 head 的 fork `build-pr` 云端 APK 构建待 Actions 完成；本地验收不替代云端结果。

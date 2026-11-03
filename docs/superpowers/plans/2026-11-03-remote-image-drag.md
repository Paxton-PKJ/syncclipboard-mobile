# Remote Image Drag Implementation Plan

> **For agentic workers:** Execute this coupled feature in the assigned implementation session; do not delegate. Steps use checkbox syntax for tracking.

**Goal:** Let a fully downloaded image in the remote clipboard card be long-pressed and dragged into another Android app.

**Architecture:** Extend the existing native-util Expo module with a native drag-source view wrapping the existing image preview. Native code owns long-press recognition, validates and snapshots the local image into an independent FileProvider cache, and starts a global read-only Android drag. Other platforms retain the ordinary image preview.

**Tech Stack:** Expo SDK 55, React Native 0.83, TypeScript, Kotlin, Android FileProvider.

**Spec:** This task's user requirement: 已经完整保存本地且显示在远程剪切板卡片中的图片，能长按使用 Android drag-and-drop 跨应用传图片。

## Global Constraints

- No new dependencies, permissions, iOS implementation, commits, or pushes.
- Only remote local-file image previews can initiate dragging; native code revalidates actual data.
- Share only content URIs with global and URI-read drag flags; use separate drag cache retained for 24 hours.
- Keep normal scrolling until a stationary long press; use the displayed preview for the drag shadow.
- Static imports must remain safe outside Android. Report initiation failure with localized card messaging.

## Review Focus

- Missing, empty, partially downloaded or invalid image files must fail safely.
- A swipe over the preview must scroll; only a stationary long press starts a drag.
- Clipboard cache cleanup must not invalidate a previously started drag.
- Local cards, non-images, remote-only URIs and iOS must have no drag source.
- Cross-app acceptance depends on Android and the destination accepting image drops; mocks cannot prove it.

### Task 1: Remote image drag source

**Files:**

- Modify `src/components/CurrentClipboardCard.tsx` for conditional native wrapper, hint and failure messaging.
- Create `modules/native-util/src/ImageDragSource.tsx` for a guarded native view API.
- Modify `modules/native-util/android/src/main/java/expo/modules/nativeutil/NativeUtilModule.kt` to register the view.
- Create `modules/native-util/android/src/main/java/expo/modules/nativeutil/ImageDragSourceView.kt` and `ImageDragFileStore.kt` for native gestures and validated snapshots.
- Modify `modules/native-util/android/src/main/res/xml/native_util_file_paths.xml` for the isolated drag cache.
- Modify `src/i18n/locales/en.ts` and `zh.ts` for drag hint and failure copy.
- Create `src/__tests__/currentClipboardImageDrag.test.tsx` for source eligibility and failure handling.

**Interfaces:** `ImageDragSource({fileUri, expectedSize, onDragStartFailed, children, ...ViewProps})` wraps the preview on Android and falls back to a plain view elsewhere.

- [x] Add component tests for remote downloaded image, local card, non-image, missing URI, unsupported platform and failure event.
- [x] Implement guarded wrapper and integrate remote card with localized visible/accessibility hint.
- [x] Implement native long press with movement cancellation and parent-scroll compatibility; start the drag with preview shadow.
- [x] Validate file URI, nonempty regular file, optional positive expected size and decoded image MIME; snapshot into isolated cache and expire old completed snapshots after 24 hours.
- [x] Run `npm run lint:fix`, `npm run type-check`, `npm run test`, `npm run format-docs`; inspect diff for unrelated formatting.
- [x] Compile native-util Kotlin using the already generated Android project: `:native-util:compileDebugKotlin` completed; `:native-util:testDebugUnitTest` reported `NO-SOURCE`.
- [x] Inspect SDK/JDK/adb availability: Android SDK 36 and an API 31 emulator are available; the release app was subsequently built and installed on the test emulator.
- [x] Verify preview layout, normal scrolling over the image, and stationary long-press initiation with a fully downloaded remote image displayed; source drag logs contain image/png, content URI and flags 0x101. Drag-shadow appearance was not separately asserted by the screenshot script.
- [ ] Verify a destination app accepts the drop and can read the image content URI after the source clipboard cache is cleaned.

### Validation results (2026-11-03)

- `npm run lint:fix`, followed by `npm run type-check`: passed.
- `npm run test -- --runInBand`: 55 suites and 448 tests passed.
- `npm run format-docs` and `git diff --check`: passed; no unrelated tracked formatting changes.
- Initial `:native-util:compileDebugKotlin :native-util:testDebugUnitTest` attempt failed because SDK location was unset. With `ANDROID_HOME` set, the default JBR 21.0.9 failed because its `bin/jlink.exe` is missing. Supplying `JAVA_HOME=C:/Program Files/Android/Android Studio/jbr` (21.0.10, with jlink) allowed the Kotlin compilation to complete.
- No native-util `src/test` or `src/androidTest` files exist.
- Initial device inspection found no installed app. Subsequent preview regression verification built/installed a release APK and configured only the disposable emulator with a dedicated local HTTP fixture backend.

### Preview layout regression and fix (2026-11-03)

- Root cause: `ExpoView` inherits Android `LinearLayout` measurement/layout. Calling its implementation remeasured/repositioned the Fabric-managed image child from 906×525 to 1×1. The content remained downloaded and draggable while its preview was blank; resizing the window happened to reveal it.
- `ImageDragSourceView` now measures only itself with `View.getDefaultSize` and leaves child layout to Fabric with an empty `onLayout`. Temporary diagnostic logging was removed.
- Actual red reproduction: A/B/C each had 0 fixture-color pixels before resize, versus 425,388 / 425,380 / 425,383 after resize; the reproduction exited 1. The blank B image still initiated a native drag.
- Actual green: the release build completed in 58 seconds and installed successfully on the x86_64 test emulator. Two reproduction runs, including force-stop/restart, exited 0. A/B/C had 440,358 / 440,353 / 440,353 pixels before resize and 425,388 / 425,380 / 425,383 afterward.
- Normal fast swipes scrolled without starting a drag. A stationary long press emitted a source drag with `image/png`, a `content://` URI and global/read flags `0x101`. These checks do not establish destination acceptance or URI readability after clipboard-cache cleanup; the user's separate report that dragging works is not counted as this regression run's cross-app test.
- The persistent regression is `scripts/check-remote-image-preview.py`; setup and isolated-fixture instructions are in `scripts/check-remote-image-preview.md`. Generated images and screenshot evidence stay outside the repository. The script asserts visible image pixels both before and after resize, and restores the original display-size override in `finally`.
- Persistent-script verification: `prepare` exited 0 against a new isolated fixture directory; `check --cycles 2 --restart-app com.jericx.syncclipboardmobile` exited 0 with all 12 screenshots passing and the same A/B/C pixel counts listed above in both cycles. Final `wm size` returned the original 1080×2400 physical size without an override. `npm run test` passed all 55 suites / 448 tests; Python syntax, documentation formatting and diff checks passed.

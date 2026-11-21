package expo.modules.nativeutil

import android.content.ContentResolver
import android.content.Context
import android.os.Build
import android.view.DragEvent
import android.view.View
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * 原生拖放接收容器。
 * - Fabric 独占 React 子视图布局，因此自测量自身并用 no-op onLayout 避免二次布局冲突。
 * - 在外部拖拽激活期间直接处理 DragEvent，避免内部 TextInput 抢占文本拖放并维持全屏落点语义。
 * - 带有非空 localState 的本应用内拖出事件直接放行给原始手势树，绝不触发自拖入。
 */
class DropTargetView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    private val onDragStateChange by EventDispatcher()
    private val onDropReceived by EventDispatcher()

    private var dragActive = false
    private var dragEntered = false

    var dropEnabled: Boolean = true
        set(value) {
            if (field == value) return
            field = value
            if (!value) {
                updateDragState(active = false, entered = false)
            }
        }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(
            View.getDefaultSize(suggestedMinimumWidth, widthMeasureSpec),
            View.getDefaultSize(suggestedMinimumHeight, heightMeasureSpec)
        )
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {}

    override fun dispatchDragEvent(event: DragEvent): Boolean {
        if (event.localState != null) {
            return super.dispatchDragEvent(event)
        }
        if (!dropEnabled && !dragActive) {
            return super.dispatchDragEvent(event)
        }
        return handleExternalDragEvent(event)
    }

    override fun onDetachedFromWindow() {
        updateDragState(active = false, entered = false)
        super.onDetachedFromWindow()
    }

    private fun handleExternalDragEvent(event: DragEvent): Boolean {
        return when (event.action) {
            DragEvent.ACTION_DRAG_STARTED -> {
                if (!dropEnabled || event.localState != null) {
                    false
                } else if (!IncomingContentParser.canAcceptClipDescription(event.clipDescription)) {
                    super.dispatchDragEvent(event)
                } else {
                    updateDragState(active = true, entered = false)
                    true
                }
            }

            DragEvent.ACTION_DRAG_ENTERED -> {
                if (!dragActive) return false
                updateDragState(active = true, entered = true)
                true
            }

            DragEvent.ACTION_DRAG_LOCATION -> dragActive

            DragEvent.ACTION_DRAG_EXITED -> {
                if (!dragActive) return false
                updateDragState(active = true, entered = false)
                true
            }

            DragEvent.ACTION_DROP -> {
                val wasActive = dragActive
                updateDragState(active = false, entered = false)
                if (!wasActive || !dropEnabled || event.localState != null) {
                    return false
                }

                val source = IncomingContentParser.parseDropClipData(event.clipData)
                if (source.kind == ParsedIncomingSource.Kind.EMPTY) {
                    return false
                }
                if (source.kind == ParsedIncomingSource.Kind.UNSUPPORTED_MIXED) {
                    onDropReceived(
                        IncomingSessionMeta(
                            sessionId = "",
                            kind = IncomingContentImportManager.KIND_UNSUPPORTED_MIXED,
                            itemCount = 0
                        ).toMap()
                    )
                    return false
                }

                val permissions = if (
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.N &&
                    source.uris.any { it.scheme == ContentResolver.SCHEME_CONTENT }
                ) {
                    runCatching { appContext.currentActivity?.requestDragAndDropPermissions(event) }.getOrNull()
                } else {
                    null
                }

                val session = try {
                    IncomingContentImportManager.startSession(
                        context = context.applicationContext,
                        source = source,
                        sourceOrigin = IncomingContentImportManager.ORIGIN_DROP,
                        readGrantUris = if (permissions != null) source.uris.toSet() else emptySet(),
                        notifyShareEvent = false,
                        onReleasePermissions = { runCatching { permissions?.release() } }
                    )
                } catch (e: Exception) {
                    runCatching { permissions?.release() }
                    NativeLogger.e(TAG, "Failed to start drop session", e)
                    return false
                }

                if (session.kind == IncomingContentImportManager.KIND_EMPTY || session.sessionId.isEmpty()) {
                    return false
                }

                onDropReceived(session.toMap())
                true
            }

            DragEvent.ACTION_DRAG_ENDED -> {
                updateDragState(active = false, entered = false)
                true
            }

            else -> super.dispatchDragEvent(event)
        }
    }

    private fun updateDragState(active: Boolean, entered: Boolean) {
        if (dragActive == active && dragEntered == entered) return
        dragActive = active
        dragEntered = entered
        onDragStateChange(
            mapOf(
                "active" to active,
                "entered" to entered
            )
        )
    }

    private companion object {
        const val TAG = "DropTargetView"
    }
}

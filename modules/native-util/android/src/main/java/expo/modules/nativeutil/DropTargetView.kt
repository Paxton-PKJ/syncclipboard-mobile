package expo.modules.nativeutil

import android.content.ContentResolver
import android.content.Context
import android.os.Build
import android.view.DragEvent
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/** 透明拖放目标。由系统分发拖拽焦点及 ENTERED/EXITED，普通触摸由下层 RN 界面处理。 */
class DropTargetView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    private val onDragStateChange by EventDispatcher()
    private val onDropReceived by EventDispatcher()

    private var dragActive = false
    private var dragEntered = false

    var acceptsDrop: Boolean = false

    var dropEnabled: Boolean = true
        set(value) {
            if (field == value) return
            field = value
            if (!value) {
                updateDragState(active = false, entered = false)
            }
        }

    override fun onDetachedFromWindow() {
        updateDragState(active = false, entered = false)
        super.onDetachedFromWindow()
    }

    override fun onDragEvent(event: DragEvent): Boolean {
        return when (event.action) {
            DragEvent.ACTION_DRAG_STARTED -> {
                if (!dropEnabled || event.localState != null) {
                    false
                } else if (!IncomingContentParser.canAcceptClipDescription(event.clipDescription)) {
                    super.onDragEvent(event)
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
                if (!wasActive || !dropEnabled || !acceptsDrop || event.localState != null) {
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

            else -> super.onDragEvent(event)
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

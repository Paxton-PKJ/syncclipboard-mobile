package expo.modules.nativeutil

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Point
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.DragEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import com.facebook.react.uimanager.events.NativeGestureUtil
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.lang.ref.WeakReference
import kotlin.math.hypot

/** 列表级手势持有者：识别前保留按钮和滚动，激活后不依赖起始行。 */
class HistoryGestureSurfaceView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    private val onSelectionGesture by EventDispatcher()
    private val onDragRequested by EventDispatcher()
    private val onDragEnded by EventDispatcher()
    private val handler = Handler(Looper.getMainLooper())
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var session: HistoryGestureSession? = null
    private var lastTouch: MotionEvent? = null
    private var downX = 0f
    private var downY = 0f
    private var payload: HistoryDragPayload? = null
    private var sourceMarker: WeakReference<HistoryDragSourceView>? = null
    var gestureEpoch: Int = 0
        set(value) { if (field != value) cancelGesture(); field = value }
    var gestureEnabled: Boolean = true
        set(value) { if (!value) cancelGesture(); field = value }

    private val activate = Runnable {
        val current = session
        val event = lastTouch
        if (current != null && event != null && isAttachedToWindow && current.activate()) {
            NativeGestureUtil.notifyNativeGestureStarted(this, event)
            val cancel = MotionEvent.obtain(event).apply { action = MotionEvent.ACTION_CANCEL }
            super.dispatchTouchEvent(cancel)
            cancel.recycle()
            parent?.requestDisallowInterceptTouchEvent(true)
            if (current.mode == "select") emitSelection(current, "start", event)
            else onDragRequested(mapOf("gestureId" to current.id, "sourceId" to current.sourceId))
        }
    }

    init {
        setOnDragListener { _, event ->
            when (event.action) {
                DragEvent.ACTION_DRAG_STARTED -> session?.started == true
                DragEvent.ACTION_DRAG_ENDED -> {
                    val current = session
                    payload?.release()
                    payload = null
                    if (current?.started == true) onDragEnded(mapOf("gestureId" to current.id, "completed" to event.result))
                    finishTouch()
                    session = null
                    true
                }
                else -> false
            }
        }
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(View.getDefaultSize(suggestedMinimumWidth, widthMeasureSpec),
            View.getDefaultSize(suggestedMinimumHeight, heightMeasureSpec))
    }
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {}

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            if (session?.started == true) return super.dispatchTouchEvent(event)
            cancelGesture()
            if (gestureEnabled) {
                val marker = findMarker(this, event.x, event.y)
                if (marker != null && marker.gestureMode != "disabled" && marker.sourceId.isNotEmpty()) {
                    session = HistoryGestureSession(ids.incrementAndGet(), marker.sourceId, marker.gestureMode)
                    sourceMarker = WeakReference(marker)
                    downX = event.x; downY = event.y
                    remember(event)
                    handler.postDelayed(activate, 500)
                }
            }
        }
        val current = session
        if (current != null && !current.started) {
            remember(event)
            if (!current.active && (event.actionMasked == MotionEvent.ACTION_POINTER_DOWN ||
                (event.actionMasked == MotionEvent.ACTION_MOVE && hypot(event.x - downX, event.y - downY) > slop))) {
                cancelGesture()
            } else if (current.active) {
                when (event.actionMasked) {
                    MotionEvent.ACTION_MOVE -> if (current.mode == "select") emitSelection(current, "move", event)
                    MotionEvent.ACTION_UP -> {
                        if (current.mode == "select") emitSelection(current, "end", event)
                        current.cancel(); finishTouch(); session = null
                    }
                    MotionEvent.ACTION_CANCEL, MotionEvent.ACTION_POINTER_DOWN -> cancelGesture()
                }
                return true
            } else if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
                cancelGesture()
            }
        }
        // Still dispatch to children first so buttons and scroll containers keep their gestures.
        // Static text may reject DOWN; retain that candidate's stream so UP/CANCEL can stop
        // the delayed activation. Keep the pre-cleanup session for terminal-event handling.
        val handled = super.dispatchTouchEvent(event)
        return handled || (current != null && !current.started)
    }

    override fun onInterceptTouchEvent(event: MotionEvent) = session?.active == true || super.onInterceptTouchEvent(event)
    override fun onTouchEvent(event: MotionEvent) = session?.active == true || super.onTouchEvent(event)

    fun cancelGesture() {
        val current = session
        handler.removeCallbacks(activate)
        // A global drag normally moves focus to the receiving app. Never revoke its URI here.
        if (current?.started == true) return
        if (current?.active == true && current.mode == "select") lastTouch?.let { emitSelection(current, "cancel", it) }
        current?.cancel()
        finishTouch()
        session = null
    }

    fun startDrag(gestureId: Int, items: List<Map<String, Any?>>, promise: Promise) {
        val current = session
        if (current == null || current.id != gestureId || current.cancelled || !current.active || current.mode != "drag") {
            promise.resolve(failed("CANCELLED")); return
        }
        if (!current.beginPreparing()) { promise.resolve(failed("BUSY")); return }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N || !isAttachedToWindow || width <= 0 || height <= 0 || appContext.currentActivity == null) {
            promise.resolve(failed("UNAVAILABLE")); cancelGesture(); return
        }
        // Expo decoded this invocation into an independent value tree; IO runs only once per session.
        executor.execute {
            val prepared = runCatching { HistoryDragPayload.prepare(context, items) { current.cancelled } }
            handler.post {
                val batch = prepared.getOrNull()
                if (current.cancelled || session !== current || !isAttachedToWindow) {
                    batch?.discard(); promise.resolve(failed("CANCELLED"))
                } else if (batch == null) {
                    val error = prepared.exceptionOrNull()
                    promise.resolve(if (error is HistoryDragFailure) failed(error.code, error.itemId) else failed("START_FAILED"))
                    cancelGesture()
                } else {
                    payload = batch
                    // Set before the synchronous DRAG_STARTED dispatch so the source accepts the end event.
                    current.started = true
                    val started = runCatching {
                        val marker = sourceMarker?.get()?.takeIf { it.sourceId == current.sourceId }
                        startDragAndDrop(batch.clipData, BatchShadow(marker, batch.clipData.itemCount), null,
                            View.DRAG_FLAG_GLOBAL or View.DRAG_FLAG_GLOBAL_URI_READ)
                    }.getOrDefault(false)
                    if (started) {
                        finishTouch()
                        promise.resolve(mapOf("started" to true))
                    } else {
                        current.started = false; payload = null; batch.discard()
                        promise.resolve(failed("START_FAILED")); cancelGesture()
                    }
                }
            }
        }
    }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        if (!hasWindowFocus) cancelGesture()
    }
    override fun onDetachedFromWindow() {
        cancelGesture()
        // A detached successful source still gives the receiver the full retention window.
        payload?.release(); payload = null
        finishTouch(); session = null; sourceMarker = null
        super.onDetachedFromWindow()
    }
    private fun remember(event: MotionEvent) {
        lastTouch?.recycle(); lastTouch = MotionEvent.obtain(event)
    }
    private fun finishTouch() {
        handler.removeCallbacks(activate)
        lastTouch?.let { if (session?.active == true) NativeGestureUtil.notifyNativeGestureEnded(this, it); it.recycle() }
        lastTouch = null
        parent?.requestDisallowInterceptTouchEvent(false)
    }
    // Surface-local dp: raw screen coordinates drift from RN window coordinates in scaled or
    // moved freeform windows, while event.x/y stay in this view's own frame.
    private fun emitSelection(current: HistoryGestureSession, phase: String, event: MotionEvent) {
        val density = resources.displayMetrics.density
        onSelectionGesture(mapOf("gestureId" to current.id, "sourceId" to current.sourceId,
            "phase" to phase, "x" to event.x / density, "y" to event.y / density))
    }
    /** Hit-tests in the parent's local coordinates, mirroring ViewGroup touch transformation. */
    private fun findMarker(view: View, x: Float, y: Float): HistoryDragSourceView? {
        if (view.visibility != View.VISIBLE) return null
        if (x < 0 || y < 0 || x >= view.width || y >= view.height) return null
        if (view is ViewGroup) for (index in view.childCount - 1 downTo 0) {
            val child = view.getChildAt(index)
            val point = floatArrayOf(x + view.scrollX - child.left, y + view.scrollY - child.top)
            if (!child.matrix.isIdentity) Matrix().also { child.matrix.invert(it) }.mapPoints(point)
            findMarker(child, point[0], point[1])?.let { return it }
        }
        return view as? HistoryDragSourceView
    }
    private fun failed(code: String, itemId: String? = null): Map<String, Any> =
        mutableMapOf<String, Any>("started" to false, "code" to code).apply { if (itemId != null) put("itemId", itemId) }

    /** Bounded card thumbnail and batch count, never a shadow of the entire list. */
    private inner class BatchShadow(private val source: View?, private val count: Int) : View.DragShadowBuilder() {
        private val density = resources.displayMetrics.density
        private val shadowWidth = (240 * density).toInt()
        private val shadowHeight = (160 * density).toInt()
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        override fun onProvideShadowMetrics(size: Point, touch: Point) {
            size.set(shadowWidth, shadowHeight); touch.set(shadowWidth / 2, shadowHeight / 2)
        }
        override fun onDrawShadow(canvas: Canvas) {
            paint.color = Color.WHITE
            canvas.drawRoundRect(0f, 0f, shadowWidth.toFloat(), shadowHeight.toFloat(), 12 * density, 12 * density, paint)
            if (source != null && source.isAttachedToWindow && source.width > 0 && source.height > 0) {
                val save = canvas.save()
                val scale = minOf(shadowWidth.toFloat() / source.width, shadowHeight.toFloat() / source.height)
                canvas.scale(scale, scale); source.draw(canvas); canvas.restoreToCount(save)
            }
            paint.color = Color.rgb(35, 70, 140)
            canvas.drawRoundRect(shadowWidth - 66 * density, 4 * density, shadowWidth - 4 * density, 36 * density,
                16 * density, 16 * density, paint)
            paint.color = Color.WHITE; paint.textSize = 18 * density; paint.textAlign = Paint.Align.CENTER
            canvas.drawText(count.toString(), shadowWidth - 35 * density, 27 * density, paint)
        }
    }

    companion object {
        private val ids = AtomicInteger()
        private val executor = Executors.newSingleThreadExecutor()
    }
}

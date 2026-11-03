package expo.modules.nativeutil

import android.content.ClipData
import android.content.ClipDescription
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.DragEvent
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.Executors

/** 原生负责长按，普通滑动仍由父 ScrollView 拦截；拖拽开始后由系统接管。 */
class ImageDragSourceView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    // Fabric 负责 React 子视图的测量和布局；ExpoView 的 LinearLayout 实现会覆盖其尺寸。
    // 这里只按 View 的默认语义测量容器自身，不让 Android 重新测量子视图。
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(
            View.getDefaultSize(suggestedMinimumWidth, widthMeasureSpec),
            View.getDefaultSize(suggestedMinimumHeight, heightMeasureSpec)
        )
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        // 子视图位置由 Fabric 设置，不能调用 LinearLayout.onLayout 重新排列。
    }

    var fileUri: String = ""
    var expectedSize: Long? = null
    private val onDragStartFailed by EventDispatcher()
    private var touching = false
    private var preparing = false
    private var snapshot: ImageDragFileStore.Snapshot? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val detector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(event: MotionEvent) = true
        override fun onLongPress(event: MotionEvent) = beginDrag()
    })

    init {
        setOnDragListener { _, event ->
            when (event.action) {
                DragEvent.ACTION_DRAG_STARTED -> snapshot != null
                DragEvent.ACTION_DRAG_ENDED -> {
                    snapshot?.let(ImageDragFileStore::release)
                    snapshot = null
                    parent?.requestDisallowInterceptTouchEvent(false)
                    true
                }
                else -> false
            }
        }
    }

    // 图片子视图不接管触摸，使长按计时可靠；不阻止父级拦截滚动手势。
    override fun onInterceptTouchEvent(event: MotionEvent) = true

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> touching = true
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> touching = false
        }
        detector.onTouchEvent(event)
        return true
    }

    override fun onDetachedFromWindow() {
        touching = false
        snapshot?.let(ImageDragFileStore::release)
        snapshot = null
        parent?.requestDisallowInterceptTouchEvent(false)
        super.onDetachedFromWindow()
    }

    private fun fail() {
        parent?.requestDisallowInterceptTouchEvent(false)
        onDragStartFailed(emptyMap<String, Any>())
    }

    private fun beginDrag() {
        if (preparing || snapshot != null) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N || !isAttachedToWindow ||
            width <= 0 || height <= 0 || appContext.currentActivity == null) {
            fail()
            return
        }
        preparing = true
        val source = fileUri
        val size = expectedSize
        parent?.requestDisallowInterceptTouchEvent(true)
        executor.execute {
            val result = runCatching { ImageDragFileStore.prepare(context, source, size) }
            mainHandler.post {
                preparing = false
                val prepared = result.getOrNull()
                if (prepared == null) {
                    fail()
                } else if (!touching || !isAttachedToWindow || fileUri != source || appContext.currentActivity == null) {
                    ImageDragFileStore.release(prepared)
                    fail()
                } else {
                    snapshot = prepared
                    val data = ClipData(ClipDescription("Image", arrayOf(prepared.mimeType)), ClipData.Item(prepared.uri))
                    val started = runCatching {
                        startDragAndDrop(data, View.DragShadowBuilder(this), null,
                            View.DRAG_FLAG_GLOBAL or View.DRAG_FLAG_GLOBAL_URI_READ)
                    }.getOrDefault(false)
                    if (!started) {
                        snapshot = null
                        ImageDragFileStore.release(prepared)
                        fail()
                    }
                }
            }
        }
    }

    companion object {
        private val executor = Executors.newSingleThreadExecutor()
    }
}

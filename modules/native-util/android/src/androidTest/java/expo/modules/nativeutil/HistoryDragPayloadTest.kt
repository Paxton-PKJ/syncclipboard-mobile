package expo.modules.nativeutil

import android.graphics.Bitmap
import android.content.ClipData
import android.content.ClipDescription
import android.net.Uri
import android.os.Parcel
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.test.AndroidTestCase
import android.view.MotionEvent
import android.widget.FrameLayout
import android.widget.TextView
import com.facebook.react.bridge.BridgeReactContext
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.ModulesProvider
import expo.modules.kotlin.modules.Module
import java.io.File
import java.lang.ref.WeakReference
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** 使用设备真实 Parcel、图片探测和 FileProvider 验证整组数据。 */
class HistoryDragPayloadTest : AndroidTestCase() {
    private fun onMain(block: () -> Unit) {
        val finished = CountDownLatch(1)
        var failure: Throwable? = null
        Handler(Looper.getMainLooper()).post {
            try { block() } catch (error: Throwable) { failure = error } finally { finished.countDown() }
        }
        assertTrue("Main thread finished", finished.await(60, TimeUnit.SECONDS))
        failure?.let { throw it }
    }

    /** 实际父子 dispatch：静态文本不消费 DOWN，Surface 必须持有后续 UP/CANCEL。 */
    fun testPendingStaticTextOwnsTouchUntilUpOrParentCancel() = onMain {
        val reactContext = BridgeReactContext(context)
        val appContext = AppContext(object : ModulesProvider {
            override fun getModulesMap(): Map<Class<out Module>, String?> = emptyMap()
        }, expo.modules.core.ModuleRegistry(emptyList(), emptyList()), WeakReference(reactContext))
        val parentEvents = mutableListOf<Int>()
        var interceptMove = false
        val parent = object : FrameLayout(context) {
            override fun onInterceptTouchEvent(event: MotionEvent): Boolean =
                interceptMove && event.actionMasked == MotionEvent.ACTION_MOVE
            override fun onTouchEvent(event: MotionEvent): Boolean {
                parentEvents.add(event.actionMasked)
                return true
            }
        }
        val surface = HistoryGestureSurfaceView(context, appContext)
        val marker = HistoryDragSourceView(context, appContext).apply {
            sourceId = "static-text"
            gestureMode = "drag"
        }
        val text = TextView(context).apply { this.text = "Static text" }
        val surfaceEvents = mutableListOf<Int>()
        surface.setOnTouchListener { _, event -> surfaceEvents.add(event.actionMasked); false }
        parent.addView(surface)
        surface.addView(marker)
        marker.addView(text)
        parent.layout(0, 0, 200, 200)
        surface.layout(0, 0, 200, 200)
        marker.layout(0, 0, 200, 200)
        text.layout(0, 0, 200, 200)
        val downTime = SystemClock.uptimeMillis()
        fun dispatch(action: Int, x: Float = 20f) {
            val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, 20f, 0)
            try { assertTrue(parent.dispatchTouchEvent(event)) } finally { event.recycle() }
        }
        fun assertPendingCleared() {
            listOf("session", "lastTouch").forEach { name ->
                val field = HistoryGestureSurfaceView::class.java.getDeclaredField(name).apply { isAccessible = true }
                assertNull("$name cleared by actual terminal event", field.get(surface))
            }
        }
        try {
            dispatch(MotionEvent.ACTION_DOWN)
            assertTrue("Surface retains DOWN instead of falling through to parent", parentEvents.isEmpty())
            dispatch(MotionEvent.ACTION_UP)
            assertEquals(listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP), surfaceEvents)
            assertPendingCleared()

            surfaceEvents.clear()
            dispatch(MotionEvent.ACTION_DOWN)
            interceptMove = true
            dispatch(MotionEvent.ACTION_MOVE, 100f)
            dispatch(MotionEvent.ACTION_MOVE, 120f)
            dispatch(MotionEvent.ACTION_UP, 100f)
            assertEquals(listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_CANCEL), surfaceEvents)
            assertTrue("Parent can intercept and scroll", parentEvents.contains(MotionEvent.ACTION_MOVE))
            assertPendingCleared()

            interceptMove = false
            parentEvents.clear()
            val childEvents = mutableListOf<Int>()
            text.isClickable = true
            text.setOnTouchListener { _, event -> childEvents.add(event.actionMasked); false }
            dispatch(MotionEvent.ACTION_DOWN)
            dispatch(MotionEvent.ACTION_UP)
            assertEquals("Pending recognition preserves clickable child events",
                listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP), childEvents)
            assertPendingCleared()

            text.isClickable = false
            for (enabled in listOf(true, false)) {
                surface.gestureEnabled = enabled
                marker.gestureMode = if (enabled) "disabled" else "drag"
                parentEvents.clear()
                dispatch(MotionEvent.ACTION_DOWN)
                dispatch(MotionEvent.ACTION_UP)
                assertEquals("Disabled candidate falls through", listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP), parentEvents)
                assertPendingCleared()
            }
        } finally { surface.cancelGesture() }
    }

    private fun image(name: String, format: Bitmap.CompressFormat): File {
        val file = File(context.cacheDir, name)
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        file.outputStream().use { bitmap.compress(format, 100, it) }
        bitmap.recycle()
        return file
    }
    private fun item(id: String, kind: String, file: File) = mapOf<String, Any?>(
        "id" to id, "kind" to kind, "fileUri" to Uri.fromFile(file).toString(), "expectedSize" to file.length()
    )
    private fun failure(code: String, items: List<Map<String, Any?>>, cancelled: () -> Boolean = { false }) {
        try {
            HistoryDragPayload.prepare(context, items, cancelled).discard()
            fail("Expected $code")
        } catch (error: HistoryDragFailure) { assertEquals(code, error.code) }
    }
    fun testMixedOrderFullUnicodeAndReadableUris() {
        val png = image("batch.png", Bitmap.CompressFormat.PNG)
        val jpg = image("batch.jpg", Bitmap.CompressFormat.JPEG)
        val full = "完整🙂é\n".repeat(2000) + "TAIL_UNIQUE"
        val text = File(context.cacheDir, "full.txt").apply { writeText(full) }
        val payload = HistoryDragPayload.prepare(context, listOf(item("png", "image", png),
            item("full", "textFile", text), mapOf("id" to "inline", "kind" to "text", "text" to "内联🙂"),
            item("jpg", "image", jpg))) { false }
        try {
            assertEquals(4, payload.clipData.itemCount)
            assertEquals(full, payload.clipData.getItemAt(1).text.toString())
            assertEquals("内联🙂", payload.clipData.getItemAt(2).text.toString())
            assertEquals(setOf("image/png", "image/jpeg", "text/plain"),
                (0 until payload.clipData.description.mimeTypeCount).map { payload.clipData.description.getMimeType(it) }.toSet())
            listOf(0 to png, 3 to jpg).forEach { (index, source) ->
                val uri = payload.clipData.getItemAt(index).uri
                assertEquals("content", uri.scheme)
                assertTrue(context.contentResolver.openInputStream(uri)!!.use { it.readBytes() }.contentEquals(source.readBytes()))
            }
            payload.release()
            payload.release()
            assertTrue(payload.snapshots.all { it.file.exists() })
        } finally { payload.discard() }
    }
    fun testFailureAndCancellationDiscardEntireGroup() {
        val png = image("valid.png", Bitmap.CompressFormat.PNG)
        val bad = File(context.cacheDir, "bad.png").apply { writeText("not an image") }
        val directory = File(context.cacheDir, ".native_util_drag")
        val before = directory.listFiles()?.map { it.name }?.toSet() ?: emptySet()
        failure("INVALID_IMAGE", listOf(item("good", "image", png), item("bad", "image", bad)))
        assertEquals(before, directory.listFiles()?.map { it.name }?.toSet() ?: emptySet<String>())
        var checks = 0
        failure("CANCELLED", listOf(item("good", "image", png), item("next", "image", png))) { ++checks > 8 }
        assertEquals(before, directory.listFiles()?.map { it.name }?.toSet() ?: emptySet<String>())
        failure("ITEM_NOT_READY", listOf(item("missing", "textFile", File(context.cacheDir, "absent"))))
        val invalid = File(context.cacheDir, "invalid.txt").apply { writeBytes(byteArrayOf(0xc3.toByte(), 0x28)) }
        failure("INVALID_TEXT", listOf(item("invalid", "textFile", invalid)))
    }
    fun testLimitsNeverTruncate() {
        val boundary = "界".repeat(43690) + "ab"
        val payload = HistoryDragPayload.prepare(context, listOf(mapOf("id" to "limit", "kind" to "text", "text" to boundary))) { false }
        assertEquals(boundary, payload.clipData.getItemAt(0).text.toString())
        payload.discard()
        failure("PAYLOAD_TOO_LARGE", listOf(mapOf("id" to "limit", "kind" to "text", "text" to boundary + "c")))
        val ascii = "a".repeat(HistoryDragPayload.MAX_TEXT_BYTES)
        val asciiPayload = HistoryDragPayload.prepare(context, listOf(mapOf("id" to "ascii", "kind" to "text", "text" to ascii))) { false }
        assertEquals(ascii, asciiPayload.clipData.getItemAt(0).text.toString())
        val asciiParcel = Parcel.obtain()
        try {
            asciiPayload.clipData.writeToParcel(asciiParcel, 0)
            Log.i("NativeUtilTest", "ASCII at UTF-8 limit: ${ascii.toByteArray(Charsets.UTF_8).size} text bytes; ${asciiParcel.dataSize()} Parcel bytes")
        } finally { asciiParcel.recycle(); asciiPayload.discard() }
        // Parcel may encode CharSequence with UTF-8, so ASCII alone is not a portable oversized fixture.
        // Item metadata makes this exceed the Parcel bound while total UTF-8 text stays at its exact limit.
        failure("PAYLOAD_TOO_LARGE", listOf(mapOf("id" to "parcel", "kind" to "text", "text" to "a".repeat(131072))) +
            List(20000) { mapOf("id" to "empty-$it", "kind" to "text", "text" to "") })
    }
    fun testUtf8AndParcelLimits() {
        failure("PAYLOAD_TOO_LARGE", listOf(mapOf("id" to "large", "kind" to "text", "text" to "🙂".repeat(32769))))
        val text = File(context.cacheDir, "large.txt").apply { writeText("a".repeat(131073)) }
        failure("PAYLOAD_TOO_LARGE", listOf(item("file", "textFile", text)))
        failure("PAYLOAD_TOO_LARGE", List(20000) { mapOf("id" to "$it", "kind" to "text", "text" to "") })
        failure("EMPTY_SELECTION", emptyList())
        failure("UNSUPPORTED_ITEM", listOf(mapOf("id" to "file", "kind" to "file")))
    }
    fun testExactParcelBoundaryAndChangedSource() {
        fun parcelSize(count: Int): Int {
            val parcel = Parcel.obtain()
            return try {
                val clip = ClipData(ClipDescription("History", arrayOf("text/plain")), ClipData.Item(""))
                repeat(count - 1) { clip.addItem(ClipData.Item("")) }
                clip.writeToParcel(parcel, 0)
                parcel.dataSize()
            } finally { parcel.recycle() }
        }
        var low = 1; var high = 20000
        while (low < high) {
            val middle = (low + high + 1) / 2
            if (parcelSize(middle) <= HistoryDragPayload.MAX_PARCEL_BYTES) low = middle else high = middle - 1
        }
        assertTrue(parcelSize(low) <= HistoryDragPayload.MAX_PARCEL_BYTES)
        assertTrue(parcelSize(low + 1) > HistoryDragPayload.MAX_PARCEL_BYTES)
        Log.i("NativeUtilTest", "Parcel boundary: $low items=${parcelSize(low)} bytes; ${low + 1} items=${parcelSize(low + 1)} bytes")
        HistoryDragPayload.prepare(context, List(low) { mapOf("id" to "$it", "kind" to "text", "text" to "") }) { false }.discard()
        failure("PAYLOAD_TOO_LARGE", List(low + 1) { mapOf("id" to "$it", "kind" to "text", "text" to "") })
        val changed = File(context.cacheDir, "changed.txt").apply { writeText("original") }
        var checks = 0
        failure("SOURCE_CHANGED", listOf(item("changed", "textFile", changed))) {
            if (++checks == 3) changed.appendText("changed")
            false
        }
    }
    fun testSessionFreezesModeAndOnlyPreparesOnce() {
        val session = HistoryGestureSession(1, "origin", "select")
        assertEquals("select", session.mode)
        assertTrue(session.activate())
        assertFalse(session.activate())
        assertFalse(session.beginPreparing())
        val drag = HistoryGestureSession(2, "drag", "drag")
        assertTrue(drag.activate())
        assertTrue(drag.beginPreparing())
        assertFalse(drag.beginPreparing())
        drag.cancel()
        assertTrue(drag.cancelled)
        val started = HistoryGestureSession(3, "drag", "drag")
        started.activate(); started.beginPreparing(); started.started = true; started.cancel()
        assertFalse(started.cancelled)
    }

    fun testLegacyTextCharacterSizeRequiresCompleteContentHash() {
        val text = "旧记录中文🙂é\n".repeat(100) + "FULL_TEXT_TAIL"
        val bytes = text.toByteArray(Charsets.UTF_8)
        fun hash(value: ByteArray) = MessageDigest.getInstance("SHA-256").digest(value)
            .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
        val id = hash(bytes)
        val file = File(context.cacheDir, "legacy-character-size.txt").apply { writeBytes(bytes) }
        fun legacy(sourceId: String = id, expected: Long = text.length.toLong()) = mapOf<String, Any?>(
            "id" to sourceId, "kind" to "textFile", "fileUri" to Uri.fromFile(file).toString(), "expectedSize" to expected
        )
        fun assertFullText(item: Map<String, Any?>, expected: String) {
            val payload = HistoryDragPayload.prepare(context, listOf(item)) { false }
            try {
                val actual = payload.clipData.getItemAt(0).text.toString()
                assertEquals(expected, actual)
                assertTrue(expected.toByteArray(Charsets.UTF_8).contentEquals(actual.toByteArray(Charsets.UTF_8)))
            } finally { payload.discard() }
        }
        assertTrue(text.length < bytes.size)
        assertFullText(legacy(), text)
        assertFullText(legacy(id.uppercase()), text)

        file.writeText(text.replaceFirst("旧", "新"))
        failure("SOURCE_CHANGED", listOf(legacy()))
        file.writeText(text.dropLast(1))
        failure("SOURCE_CHANGED", listOf(legacy()))
        file.writeBytes(bytes)
        failure("SOURCE_CHANGED", listOf(legacy("legacy-non-hash-id")))
        failure("SOURCE_CHANGED", listOf(legacy("0".repeat(64))))
        failure("SOURCE_CHANGED", listOf(legacy(expected = text.length.toLong() - 1)))
        failure("SOURCE_CHANGED", listOf(legacy(expected = bytes.size.toLong() + 1)))
        var checks = 0
        failure("SOURCE_CHANGED", listOf(legacy())) {
            if (++checks == 3) assertTrue(file.setLastModified(file.lastModified() + 2000))
            false
        }
        checks = 0
        failure("CANCELLED", listOf(legacy())) { ++checks == 3 }
        assertFullText(legacy("normal-byte-metadata", bytes.size.toLong()), text)

        val ascii = "ASCII unchanged"
        file.writeText(ascii)
        assertFullText(legacy("normal-ascii", ascii.length.toLong()), ascii)
        val invalid = byteArrayOf(0xc3.toByte(), 0x28, 0x61)
        file.writeBytes(invalid)
        failure("INVALID_TEXT", listOf(legacy(hash(invalid), 1)))
        val oversized = "界".repeat(43691)
        val oversizedBytes = oversized.toByteArray(Charsets.UTF_8)
        file.writeBytes(oversizedBytes)
        failure("PAYLOAD_TOO_LARGE", listOf(legacy(hash(oversizedBytes), oversized.length.toLong())))
    }
}

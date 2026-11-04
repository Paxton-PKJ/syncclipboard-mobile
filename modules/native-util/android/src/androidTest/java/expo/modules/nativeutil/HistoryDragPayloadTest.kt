package expo.modules.nativeutil

import android.graphics.Bitmap
import android.content.ClipData
import android.content.ClipDescription
import android.net.Uri
import android.os.Parcel
import android.util.Log
import android.test.AndroidTestCase
import java.io.File

/** 使用设备真实 Parcel、图片探测和 FileProvider 验证整组数据。 */
class HistoryDragPayloadTest : AndroidTestCase() {
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
}

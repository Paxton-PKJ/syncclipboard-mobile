package expo.modules.nativeutil

import android.net.Uri
import android.graphics.Bitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class ImageDragFileStoreTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun neverEvictsAnActiveSnapshotWhenTheLimitCannotFitAnotherDrag() {
        val source = File(context.cacheDir, "active-snapshot.png")
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        source.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        val snapshot = ImageDragFileStore.prepare(context, Uri.fromFile(source).toString(), source.length())
        try {
            try {
                ImageDragFileStore.cleanupDirectory(snapshot.file.parentFile!!, maxBytes = 0)
                fail("An active drag must prevent exceeding the limit")
            } catch (error: HistoryDragFailure) { assertEquals("PAYLOAD_TOO_LARGE", error.code) }
            assertTrue(snapshot.file.exists())
        } finally { ImageDragFileStore.discard(snapshot); source.delete() }
    }

    @Test
    fun evictsExpiredAndOldestFilesToReserveSpaceWithinTheCacheLimit() {
        val directory = File(context.cacheDir, "drag-cleanup-test").apply { mkdirs() }
        val now = System.currentTimeMillis()
        val expired = File(directory, "expired").apply { writeBytes(ByteArray(4)); setLastModified(now - 25 * 60 * 60 * 1000L) }
        val old = File(directory, "old").apply { writeBytes(ByteArray(4)); setLastModified(now - 2000) }
        val recent = File(directory, "recent").apply { writeBytes(ByteArray(4)); setLastModified(now - 1000) }
        try {
            ImageDragFileStore.cleanupDirectory(directory, maxBytes = 8, reserveBytes = 4, now = now)
            assertFalse(expired.exists())
            assertFalse(old.exists())
            assertTrue(recent.exists())
            assertTrue(directory.listFiles()!!.sumOf { it.length() } + 4 <= 8)
        } finally { directory.listFiles()?.forEach { it.delete() }; directory.delete() }
    }

    @Test
    fun classifiesMissingChangedAndInvalidSourcesWithExplicitCodes() {
        val file = File(context.cacheDir, "invalid-image-source").apply { writeText("invalid") }
        fun failure(uri: String, expected: Long?, code: String) {
            try {
                ImageDragFileStore.prepare(context, uri, expected)
                fail("Expected $code")
            } catch (error: HistoryDragFailure) { assertEquals(code, error.code) }
        }
        try {
            failure(Uri.fromFile(file).toString(), file.length() + 1, "SOURCE_CHANGED")
            failure(Uri.fromFile(file).toString(), file.length(), "INVALID_IMAGE")
            failure("content://unsupported/image", null, "ITEM_NOT_READY")
            file.delete()
            failure(Uri.fromFile(file).toString(), null, "ITEM_NOT_READY")
        } finally { file.delete() }
    }
}

package expo.modules.nativeutil

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNotEquals

class DownloadStreamLimitTest {
    @get:Rule
    val temp = TemporaryFolder()

    @Test
    fun `temporary downloads fit Android filename limits and remain unique in the destination directory`() {
        val destination = File(temp.root, "界".repeat(80) + ".png")
        val first = createDownloadStagingFile(destination)
        val second = createDownloadStagingFile(destination)
        assertEquals(destination.parentFile, first.parentFile)
        assertTrue(first.name.toByteArray().size <= 255)
        assertNotEquals(first, second)
        assertNotEquals(destination, first)
    }

    @Test
    fun `rejects immediately when declared content length exceeds limit without reading stream`() {
        var readCalled = false
        val input = object : InputStream() {
            override fun read(): Int {
                readCalled = true
                return -1
            }

            override fun read(b: ByteArray, off: Int, len: Int): Int {
                readCalled = true
                return -1
            }
        }
        val output = ByteArrayOutputStream()

        val signal = assertThrows(DownloadSizeLimitExceededSignal::class.java) {
            copyBoundedStream(
                input = input,
                output = output,
                totalBytes = 1025L,
                maxBytes = 1024L,
                isCancelled = { false },
                onProgress = { _, _, _ -> }
            )
        }

        assertEquals(1025L, signal.actualBytes)
        assertEquals(1024L, signal.maxBytes)
        assertEquals(false, readCalled)
        assertEquals(0, output.size())
    }

    @Test
    fun `downloads chunked stream under or at exact byte limit`() {
        val twoMiB = ByteArray(2 * 1024 * 1024) { (it % 127).toByte() }
        val limit = 5L * 1024L * 1024L
        val outUnder = ByteArrayOutputStream()
        val copiedUnder = copyBoundedStream(
            input = ByteArrayInputStream(twoMiB),
            output = outUnder,
            totalBytes = -1L,
            maxBytes = limit,
            isCancelled = { false },
            onProgress = { _, _, _ -> }
        )
        assertEquals(twoMiB.size.toLong(), copiedUnder)
        assertArrayEquals(twoMiB, outUnder.toByteArray())

        val exact = ByteArray(4096) { 0x41 }
        val outExact = ByteArrayOutputStream()
        val copiedExact = copyBoundedStream(
            input = ByteArrayInputStream(exact),
            output = outExact,
            totalBytes = -1L,
            maxBytes = 4096L,
            isCancelled = { false },
            onProgress = { _, _, _ -> }
        )
        assertEquals(4096L, copiedExact)
        assertArrayEquals(exact, outExact.toByteArray())
    }

    @Test
    fun `aborts chunked or lying stream as soon as byte limit is exceeded`() {
        val payload = ByteArray(4097) { 0x42 }
        val outChunked = ByteArrayOutputStream()

        val chunkedError = assertThrows(DownloadSizeLimitExceededSignal::class.java) {
            copyBoundedStream(
                input = ByteArrayInputStream(payload),
                output = outChunked,
                totalBytes = -1L,
                maxBytes = 4096L,
                bufferSize = 1024,
                isCancelled = { false },
                onProgress = { _, _, _ -> }
            )
        }
        assertEquals(4097L, chunkedError.actualBytes)
        assertEquals(4096, outChunked.size())

        val outLying = ByteArrayOutputStream()
        val lyingError = assertThrows(DownloadSizeLimitExceededSignal::class.java) {
            copyBoundedStream(
                input = ByteArrayInputStream(payload),
                output = outLying,
                totalBytes = 100L,
                maxBytes = 4096L,
                bufferSize = 1024,
                isCancelled = { false },
                onProgress = { _, _, _ -> }
            )
        }
        assertEquals(4097L, lyingError.actualBytes)
        assertEquals(4096, outLying.size())
    }

    @Test
    fun `allows unlimited download when maxBytes is negative and honors cancellation`() {
        val data = ByteArray(10240) { 0x5A }
        val out = ByteArrayOutputStream()
        val copied = copyBoundedStream(
            input = ByteArrayInputStream(data),
            output = out,
            totalBytes = -1L,
            maxBytes = -1L,
            isCancelled = { false },
            onProgress = { _, _, _ -> }
        )
        assertEquals(data.size.toLong(), copied)
        assertArrayEquals(data, out.toByteArray())

        assertThrows(DownloadCancelledSignal::class.java) {
            copyBoundedStream(
                input = ByteArrayInputStream(data),
                output = ByteArrayOutputStream(),
                totalBytes = -1L,
                maxBytes = 102400L,
                isCancelled = { true },
                onProgress = { _, _, _ -> }
            )
        }
    }
}

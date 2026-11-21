package expo.modules.nativeutil

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AtomicReplaceFileTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun `atomically replaces existing destination and removes staging source`() {
        val dir = tempFolder.newFolder("history")
        val dest = File(dir, "record.txt").apply { writeText("old-intact-content-19") }
        val staging = File(dir, ".record.txt.repair.tmp").apply { writeText("new-verified-content") }

        atomicReplaceFile(staging, dest)

        assertTrue(dest.exists())
        assertFalse(staging.exists())
        assertArrayEquals("new-verified-content".toByteArray(), dest.readBytes())
    }

    @Test
    fun `missing staging source throws and leaves destination intact`() {
        val dir = tempFolder.newFolder("history-missing")
        val dest = File(dir, "record.txt").apply { writeText("1234567890123456789") }
        val missingStaging = File(dir, ".missing.repair.tmp")

        assertThrows(FileNotFoundException::class.java) {
            atomicReplaceFile(missingStaging, dest)
        }

        assertTrue(dest.exists())
        assertArrayEquals("1234567890123456789".toByteArray(), dest.readBytes())
    }
}

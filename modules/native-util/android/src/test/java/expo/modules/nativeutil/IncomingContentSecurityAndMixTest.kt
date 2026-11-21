package expo.modules.nativeutil

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import java.io.ByteArrayOutputStream
import java.io.IOException
import org.junit.Test

class IncomingContentSecurityAndMixTest {
    private val ownPkg = "com.jericx.syncclipboardmobile"
    @Test
    fun `staging validates declared length and allows unknown length and empty files`() {
        fun stage(data: String, size: Long): String {
            val output = ByteArrayOutputStream()
            IncomingContentImportManager.copyIncomingStream(data.byteInputStream(), output, size) {}
            return output.toString("UTF-8")
        }
        assertEquals("abc", stage("abc", 3))
        assertEquals("abc", stage("abc", -1))
        assertEquals("", stage("", 0))
        assertThrows(IOException::class.java) { stage("ab", 3) }
        assertThrows(IOException::class.java) { stage("abc", 0) }
    }

    @Test
    fun `rejects mixed file and non-blank text drop`() {
        assertEquals(
            ParsedIncomingSource.Kind.UNSUPPORTED_MIXED,
            IncomingContentParser.classifyDropItems(fileUriCount = 1, texts = listOf("hello"))
        )
        assertEquals(
            ParsedIncomingSource.Kind.UNSUPPORTED_MIXED,
            IncomingContentParser.classifyDropItems(fileUriCount = 2, texts = listOf("  ", "world"))
        )
        assertEquals(
            ParsedIncomingSource.Kind.FILE,
            IncomingContentParser.classifyDropItems(fileUriCount = 1, texts = emptyList())
        )
        assertEquals(
            ParsedIncomingSource.Kind.FILE,
            IncomingContentParser.classifyDropItems(fileUriCount = 1, texts = listOf("", "   "))
        )
        assertEquals(
            ParsedIncomingSource.Kind.MULTIPLE,
            IncomingContentParser.classifyDropItems(fileUriCount = 2, texts = emptyList())
        )
        assertEquals(
            ParsedIncomingSource.Kind.TEXT,
            IncomingContentParser.classifyDropItems(fileUriCount = 0, texts = listOf("only text"))
        )
        assertEquals(
            ParsedIncomingSource.Kind.EMPTY,
            IncomingContentParser.classifyDropItems(fileUriCount = 0, texts = emptyList())
        )
    }

    @Test
    fun `accepts only external content with a read grant`() {
        fun validate(scheme: String, authority: String?, granted: Boolean, provider: String? = null) =
            IncomingContentImportManager.validateIncomingUriComponents(scheme, authority, ownPkg, granted) { provider }

        validate("content", "com.android.providers.media.documents", true)
        validate("content", "${ownPkg}addon.provider", true)
        assertThrows(SecurityException::class.java) { validate("file", null, true) }
        assertThrows(SecurityException::class.java) { validate("android.resource", "external", true) }
        assertThrows(SecurityException::class.java) { validate("content", "external", false) }
        assertThrows(SecurityException::class.java) { validate("content", " ", true) }
        assertThrows(SecurityException::class.java) { validate("content", "$ownPkg.customprovider", true) }
        assertThrows(SecurityException::class.java) { validate("content", "10@$ownPkg.provider", true) }
        assertThrows(SecurityException::class.java) { validate("content", "org.alias.provider", true, ownPkg) }
    }
}

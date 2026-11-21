package expo.modules.nativeutil

import android.content.ClipData
import android.content.ClipDescription
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class IncomingContentParserClipDataTest {
    private fun clipDataOf(mimeTypes: Array<String>, vararg items: ClipData.Item): ClipData {
        val clipData = ClipData(ClipDescription("drop", mimeTypes), items[0])
        for (i in 1 until items.size) {
            clipData.addItem(items[i])
        }
        return clipData
    }

    @Test
    fun `rejects single ClipData Item carrying both content URI and plain text caption`() {
        val fileUri = Uri.parse("content://com.example.provider/documents/doc.pdf")
        val clip = clipDataOf(
            arrayOf("application/pdf", "text/plain"),
            ClipData.Item("附带说明", null, null, fileUri)
        )

        val parsed = IncomingContentParser.parseDropClipData(clip)

        assertEquals(ParsedIncomingSource.Kind.UNSUPPORTED_MIXED, parsed.kind)
    }

    @Test
    fun `rejects single ClipData Item carrying both content URI and html text`() {
        val fileUri = Uri.parse("content://com.example.provider/images/pic.png")
        val clip = clipDataOf(
            arrayOf("image/png", "text/html"),
            ClipData.Item("", "<p>富文本说明</p>", null, fileUri)
        )

        val parsed = IncomingContentParser.parseDropClipData(clip)

        assertEquals(ParsedIncomingSource.Kind.UNSUPPORTED_MIXED, parsed.kind)
    }

    @Test
    fun `rejects single ClipData Item carrying file URI with blank plain text and non-blank html text`() {
        val fileUri = Uri.parse("file:///storage/emulated/0/Download/a.png")
        val clip = clipDataOf(
            arrayOf("image/png", "text/html"),
            ClipData.Item("   ", "<b>隐藏说明</b>", null, fileUri)
        )

        val parsed = IncomingContentParser.parseDropClipData(clip)

        assertEquals(ParsedIncomingSource.Kind.UNSUPPORTED_MIXED, parsed.kind)
    }

    @Test
    fun `accepts single ClipData Item with content URI and blank text as pure FILE`() {
        val fileUri = Uri.parse("content://com.example.provider/images/pic.png")
        val clip = clipDataOf(
            arrayOf("image/png"),
            ClipData.Item("   \n ", null, null, fileUri)
        )

        val parsed = IncomingContentParser.parseDropClipData(clip)

        assertEquals(ParsedIncomingSource.Kind.FILE, parsed.kind)
        assertEquals(listOf(fileUri), parsed.uris)
        assertEquals("image/png", parsed.declaredMimeType)
    }

    @Test
    fun `accepts pure single and multiple file ClipData Items`() {
        val uri1 = Uri.parse("content://com.example.provider/images/a.png")
        val uri2 = Uri.parse("content://com.example.provider/images/b.png")

        val single = IncomingContentParser.parseDropClipData(
            clipDataOf(arrayOf("image/png"), ClipData.Item(uri1))
        )
        assertEquals(ParsedIncomingSource.Kind.FILE, single.kind)
        assertEquals(listOf(uri1), single.uris)

        val multiple = IncomingContentParser.parseDropClipData(
            clipDataOf(arrayOf("image/png"), ClipData.Item(uri1), ClipData.Item(uri2))
        )
        assertEquals(ParsedIncomingSource.Kind.MULTIPLE, multiple.kind)
        assertEquals(listOf(uri1, uri2), multiple.uris)
    }

    @Test
    fun `rejects multi-item drops mixing files and text even on duplicate or second URI item`() {
        val uri1 = Uri.parse("content://com.example.provider/images/a.png")
        val uri2 = Uri.parse("content://com.example.provider/images/b.png")

        val separateItems = IncomingContentParser.parseDropClipData(
            clipDataOf(
                arrayOf("image/png", "text/plain"),
                ClipData.Item(uri1),
                ClipData.Item("说明")
            )
        )
        assertEquals(ParsedIncomingSource.Kind.UNSUPPORTED_MIXED, separateItems.kind)

        val secondItemWithCaption = IncomingContentParser.parseDropClipData(
            clipDataOf(
                arrayOf("image/png", "text/plain"),
                ClipData.Item(uri1),
                ClipData.Item("第二张图的说明", null, null, uri2)
            )
        )
        assertEquals(ParsedIncomingSource.Kind.UNSUPPORTED_MIXED, secondItemWithCaption.kind)

        val duplicateUriWithCaption = IncomingContentParser.parseDropClipData(
            clipDataOf(
                arrayOf("image/png", "text/plain"),
                ClipData.Item(uri1),
                ClipData.Item("补充说明", null, null, uri1)
            )
        )
        assertEquals(ParsedIncomingSource.Kind.UNSUPPORTED_MIXED, duplicateUriWithCaption.kind)
    }

    @Test
    fun `parses web URL ClipData Item without duplicating identical text and preserves distinct title`() {
        val webUri = Uri.parse("https://example.com/path")

        val identical = IncomingContentParser.parseDropClipData(
            clipDataOf(
                arrayOf("text/plain", "text/uri-list"),
                ClipData.Item("https://example.com/path", null, null, webUri)
            )
        )
        assertEquals(ParsedIncomingSource.Kind.TEXT, identical.kind)
        assertEquals("https://example.com/path", identical.text)

        val withTitle = IncomingContentParser.parseDropClipData(
            clipDataOf(
                arrayOf("text/plain"),
                ClipData.Item("Example", null, null, webUri)
            )
        )
        assertEquals(ParsedIncomingSource.Kind.TEXT, withTitle.kind)
        assertEquals("Example\nhttps://example.com/path", withTitle.text)
    }
}

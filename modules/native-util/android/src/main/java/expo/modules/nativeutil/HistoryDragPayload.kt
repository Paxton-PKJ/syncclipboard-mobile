package expo.modules.nativeutil

import android.content.ClipData
import android.content.ClipDescription
import android.content.Context
import android.net.Uri
import android.os.Parcel
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest

internal class HistoryDragFailure(val code: String, val itemId: String? = null) : Exception(code)

/** 一次准备整组，任何失败都丢弃尚未交给系统的全部快照。 */
internal class HistoryDragPayload(val clipData: ClipData, val snapshots: List<ImageDragFileStore.Snapshot>) {
    fun discard() = snapshots.forEach(ImageDragFileStore::discard)
    fun release() = snapshots.forEach(ImageDragFileStore::release)

    companion object {
        const val MAX_PARCEL_BYTES = 262144
        // UTF-8 和 UTF-16 的具体 Parcel 编码由系统决定，最终以实际序列化大小为准。
        private const val MAX_TEXT_CHARS = MAX_PARCEL_BYTES

        fun prepare(context: Context, items: List<Map<String, Any?>>, isCancelled: () -> Boolean): HistoryDragPayload {
            val snapshots = mutableListOf<ImageDragFileStore.Snapshot>()
            fun checkCancelled() { if (isCancelled()) throw HistoryDragFailure("CANCELLED") }
            try {
                checkCancelled()
                if (items.isEmpty()) throw HistoryDragFailure("EMPTY_SELECTION")
                val clips = mutableListOf<ClipData.Item>()
                val mimes = linkedSetOf<String>()
                var textChars = 0
                items.forEach { item ->
                    checkCancelled()
                    val id = item["id"] as? String ?: throw HistoryDragFailure("ITEM_NOT_FOUND")
                    if (id.isEmpty()) throw HistoryDragFailure("ITEM_NOT_FOUND")
                    val kind = item["kind"] as? String
                    val expectedSize = (item["expectedSize"] as? Number)?.toLong()
                    when (kind) {
                        "image" -> {
                            val source = sourceFile(item, id)
                            verifySize(source, expectedSize, id)
                            val snapshot = ImageDragFileStore.prepare(context, item["fileUri"] as String, expectedSize, isCancelled, id)
                            snapshots.add(snapshot)
                            clips.add(ClipData.Item(snapshot.uri))
                            mimes.add(snapshot.mimeType)
                        }
                        "text", "textFile" -> {
                            val remaining = MAX_TEXT_CHARS - textChars
                            val text = if (kind == "textFile") readText(item, id, remaining, isCancelled)
                            else item["text"] as? String ?: throw HistoryDragFailure("INVALID_TEXT", id)
                            // 超过此字符数时，即使每字符只占一个字节也无法放入 Parcel。
                            if (text.length > remaining) throw HistoryDragFailure("PAYLOAD_TOO_LARGE", id)
                            if (!Charsets.UTF_8.newEncoder().canEncode(text)) throw HistoryDragFailure("INVALID_TEXT", id)
                            textChars += text.length
                            clips.add(ClipData.Item(text))
                            mimes.add("text/plain")
                        }
                        else -> throw HistoryDragFailure("UNSUPPORTED_ITEM", id)
                    }
                }
                checkCancelled()
                val clipData = ClipData(ClipDescription("History", mimes.toTypedArray()), clips.first())
                clips.drop(1).forEach(clipData::addItem)
                val parcel = Parcel.obtain()
                try {
                    clipData.writeToParcel(parcel, 0)
                    if (parcel.dataSize() > MAX_PARCEL_BYTES) throw HistoryDragFailure("PAYLOAD_TOO_LARGE")
                } finally { parcel.recycle() }
                checkCancelled()
                return HistoryDragPayload(clipData, snapshots.toList())
            } catch (error: Exception) {
                snapshots.forEach(ImageDragFileStore::discard)
                throw error
            }
        }

        private fun sourceFile(item: Map<String, Any?>, id: String): File {
            val uri = Uri.parse(item["fileUri"] as? String ?: throw HistoryDragFailure("ITEM_NOT_READY", id))
            if (uri.scheme != "file" || !uri.authority.isNullOrEmpty()) throw HistoryDragFailure("ITEM_NOT_READY", id)
            val file = File(uri.path ?: throw HistoryDragFailure("ITEM_NOT_READY", id)).canonicalFile
            if (!file.isFile || !file.canRead()) throw HistoryDragFailure("ITEM_NOT_READY", id)
            return file
        }

        private fun verifySize(file: File, expected: Long?, id: String) {
            if (expected != null && expected > 0 && file.length() != expected) throw HistoryDragFailure("SOURCE_CHANGED", id)
        }

        private fun readText(item: Map<String, Any?>, id: String, limit: Int, isCancelled: () -> Boolean): String {
            val source = sourceFile(item, id)
            val size = source.length()
            val modified = source.lastModified()
            val expectedSize = (item["expectedSize"] as? Number)?.toLong()
            val sizeMismatch = expectedSize != null && expectedSize > 0 && expectedSize != size
            // 旧本地记录曾用 UTF-16 字符数保存大小；仅完整内容哈希可证明该误单位记录。
            val legacySizeCandidate = sizeMismatch && expectedSize!! < size && id.matches(Regex("[0-9a-fA-F]{64}"))
            if (sizeMismatch && !legacySizeCandidate) throw HistoryDragFailure("SOURCE_CHANGED", id)
            // 有效 UTF-8 每个 UTF-16 代码单元最多三个字节，仅读取有界的完整文件。
            val byteLimit = limit * 3
            if (size > byteLimit) throw HistoryDragFailure("PAYLOAD_TOO_LARGE", id)
            val output = ByteArrayOutputStream()
            source.inputStream().use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    if (isCancelled()) throw HistoryDragFailure("CANCELLED", id)
                    val count = input.read(buffer, 0, minOf(buffer.size, byteLimit - output.size() + 1))
                    if (count < 0) break
                    if (output.size() + count > byteLimit) throw HistoryDragFailure("PAYLOAD_TOO_LARGE", id)
                    output.write(buffer, 0, count)
                }
            }
            if (source.length() != size || source.lastModified() != modified || output.size().toLong() != size) {
                throw HistoryDragFailure("SOURCE_CHANGED", id)
            }
            val bytes = output.toByteArray()
            val text = try {
                Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
            } catch (error: Exception) { throw HistoryDragFailure("INVALID_TEXT", id) }
            if (legacySizeCandidate && expectedSize != text.length.toLong()) throw HistoryDragFailure("SOURCE_CHANGED", id)
            // 首页和历史使用 TextProfile.Hash 校验完整内容，与是否提供字节元数据无关。
            if (id.matches(Regex("[0-9a-fA-F]{64}"))) {
                val hash = MessageDigest.getInstance("SHA-256").digest(bytes)
                    .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
                if (!id.equals(hash, ignoreCase = true)) throw HistoryDragFailure("SOURCE_CHANGED", id)
            }
            return text
        }
    }
}

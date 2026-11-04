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

internal class HistoryDragFailure(val code: String, val itemId: String? = null) : Exception(code)

/** 一次准备整组，任何失败都丢弃尚未交给系统的全部快照。 */
internal class HistoryDragPayload(val clipData: ClipData, val snapshots: List<ImageDragFileStore.Snapshot>) {
    fun discard() = snapshots.forEach(ImageDragFileStore::discard)
    fun release() = snapshots.forEach(ImageDragFileStore::release)

    companion object {
        const val MAX_TEXT_BYTES = 131072
        const val MAX_PARCEL_BYTES = 262144

        fun prepare(context: Context, items: List<Map<String, Any?>>, isCancelled: () -> Boolean): HistoryDragPayload {
            val snapshots = mutableListOf<ImageDragFileStore.Snapshot>()
            fun checkCancelled() { if (isCancelled()) throw HistoryDragFailure("CANCELLED") }
            try {
                checkCancelled()
                if (items.isEmpty()) throw HistoryDragFailure("EMPTY_SELECTION")
                val clips = mutableListOf<ClipData.Item>()
                val mimes = linkedSetOf<String>()
                var textBytes = 0
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
                            val snapshot = try {
                                ImageDragFileStore.prepare(context, item["fileUri"] as String, expectedSize, isCancelled)
                            } catch (error: HistoryDragFailure) { throw error }
                            catch (error: Exception) {
                                val code = if (error.message?.contains("changed") == true) "SOURCE_CHANGED" else "INVALID_IMAGE"
                                throw HistoryDragFailure(code, id)
                            }
                            snapshots.add(snapshot)
                            clips.add(ClipData.Item(snapshot.uri))
                            mimes.add(snapshot.mimeType)
                        }
                        "text", "textFile" -> {
                            val remaining = MAX_TEXT_BYTES - textBytes
                            val text = if (kind == "textFile") readText(item, id, remaining, isCancelled)
                            else item["text"] as? String ?: throw HistoryDragFailure("INVALID_TEXT", id)
                            // A Char count above the limit cannot fit even in single-byte UTF-8.
                            if (text.length > remaining) throw HistoryDragFailure("PAYLOAD_TOO_LARGE", id)
                            val bytes = try {
                                Charsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
                                    .onUnmappableCharacter(CodingErrorAction.REPORT).encode(java.nio.CharBuffer.wrap(text)).remaining()
                            } catch (error: Exception) { throw HistoryDragFailure("INVALID_TEXT", id) }
                            if (bytes > remaining) throw HistoryDragFailure("PAYLOAD_TOO_LARGE", id)
                            textBytes += bytes
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
            verifySize(source, (item["expectedSize"] as? Number)?.toLong(), id)
            if (size > limit) throw HistoryDragFailure("PAYLOAD_TOO_LARGE", id)
            val output = ByteArrayOutputStream()
            source.inputStream().use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    if (isCancelled()) throw HistoryDragFailure("CANCELLED", id)
                    val count = input.read(buffer, 0, minOf(buffer.size, limit - output.size() + 1))
                    if (count < 0) break
                    if (output.size() + count > limit) throw HistoryDragFailure("PAYLOAD_TOO_LARGE", id)
                    output.write(buffer, 0, count)
                }
            }
            if (source.length() != size || source.lastModified() != modified || output.size().toLong() != size) {
                throw HistoryDragFailure("SOURCE_CHANGED", id)
            }
            return try {
                Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(output.toByteArray())).toString()
            } catch (error: Exception) { throw HistoryDragFailure("INVALID_TEXT", id) }
        }
    }
}

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
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** 拖拽准备与缓存清理共用的单线程执行器，保证快照写入和清理串行。 */
internal val dragPreparationExecutor: ExecutorService = Executors.newSingleThreadExecutor()

internal class DragFailure(val code: String, val itemId: String? = null) : Exception(code)

/** 一次准备整组，任何失败都丢弃尚未交给系统的全部快照。 */
internal class DragPayload(val clipData: ClipData, val snapshots: List<ImageDragFileStore.Snapshot>) {
    fun discard() = snapshots.forEach(ImageDragFileStore::discard)
    fun release() = snapshots.forEach(ImageDragFileStore::release)

    companion object {
        const val MAX_PARCEL_BYTES = 262144
        /** ClipData 描述标签；首页与历史页共用同一拖拽会话。 */
        private const val CLIP_LABEL = "SyncClipboard"
        /** 文本记录 id 为 SHA-256 内容哈希时的格式。 */
        private val CONTENT_HASH_ID = Regex("[0-9a-fA-F]{64}")

        fun prepare(context: Context, items: List<Map<String, Any?>>, isCancelled: () -> Boolean): DragPayload {
            val snapshots = mutableListOf<ImageDragFileStore.Snapshot>()
            fun checkCancelled() { if (isCancelled()) throw DragFailure("CANCELLED") }
            try {
                checkCancelled()
                if (items.isEmpty()) throw DragFailure("EMPTY_SELECTION")
                val clips = mutableListOf<ClipData.Item>()
                val mimes = linkedSetOf<String>()
                var textChars = 0
                items.forEach { item ->
                    checkCancelled()
                    val id = item["id"] as? String ?: throw DragFailure("ITEM_NOT_FOUND")
                    if (id.isEmpty()) throw DragFailure("ITEM_NOT_FOUND")
                    val kind = item["kind"] as? String
                    val expectedSize = (item["expectedSize"] as? Number)?.toLong()
                    when (kind) {
                        "image" -> {
                            // 来源文件的存在性与大小校验统一由 ImageDragFileStore.prepare 负责。
                            val fileUri = item["fileUri"] as? String ?: throw DragFailure("ITEM_NOT_READY", id)
                            val snapshot = ImageDragFileStore.prepare(context, fileUri, expectedSize, isCancelled, id)
                            snapshots.add(snapshot)
                            clips.add(ClipData.Item(snapshot.uri))
                            mimes.add(snapshot.mimeType)
                        }
                        "text", "textFile" -> {
                            // 字符预算直接取 Parcel 字节上限：每字符至少占一个字节，超过即不可能放入；
                            // UTF-8/UTF-16 的具体编码由系统决定，最终以实际序列化大小为准。
                            val remaining = MAX_PARCEL_BYTES - textChars
                            val text = if (kind == "textFile") readText(item, id, remaining, isCancelled)
                            else item["text"] as? String ?: throw DragFailure("INVALID_TEXT", id)
                            if (text.length > remaining) throw DragFailure("PAYLOAD_TOO_LARGE", id)
                            if (!Charsets.UTF_8.newEncoder().canEncode(text)) throw DragFailure("INVALID_TEXT", id)
                            textChars += text.length
                            clips.add(ClipData.Item(text))
                            mimes.add("text/plain")
                        }
                        else -> throw DragFailure("UNSUPPORTED_ITEM", id)
                    }
                }
                checkCancelled()
                val clipData = ClipData(ClipDescription(CLIP_LABEL, mimes.toTypedArray()), clips.first())
                clips.drop(1).forEach(clipData::addItem)
                val parcel = Parcel.obtain()
                try {
                    clipData.writeToParcel(parcel, 0)
                    if (parcel.dataSize() > MAX_PARCEL_BYTES) throw DragFailure("PAYLOAD_TOO_LARGE")
                } finally { parcel.recycle() }
                checkCancelled()
                return DragPayload(clipData, snapshots.toList())
            } catch (error: Exception) {
                snapshots.forEach(ImageDragFileStore::discard)
                throw error
            }
        }

        private fun sourceFile(item: Map<String, Any?>, id: String): File {
            val uri = Uri.parse(item["fileUri"] as? String ?: throw DragFailure("ITEM_NOT_READY", id))
            if (uri.scheme != "file" || !uri.authority.isNullOrEmpty()) throw DragFailure("ITEM_NOT_READY", id)
            val file = File(uri.path ?: throw DragFailure("ITEM_NOT_READY", id)).canonicalFile
            if (!file.isFile || !file.canRead()) throw DragFailure("ITEM_NOT_READY", id)
            return file
        }

        private fun readText(item: Map<String, Any?>, id: String, limit: Int, isCancelled: () -> Boolean): String {
            val source = sourceFile(item, id)
            val size = source.length()
            val modified = source.lastModified()
            val expectedSize = (item["expectedSize"] as? Number)?.toLong()
            val sizeMismatch = expectedSize != null && expectedSize > 0 && expectedSize != size
            // 旧本地记录曾用 UTF-16 字符数保存大小；仅完整内容哈希可证明该误单位记录。
            val legacySizeCandidate = sizeMismatch && expectedSize!! < size && id.matches(CONTENT_HASH_ID)
            if (sizeMismatch && !legacySizeCandidate) throw DragFailure("SOURCE_CHANGED", id)
            // 有效 UTF-8 每个 UTF-16 代码单元最多三个字节，仅读取有界的完整文件。
            val byteLimit = limit * 3
            if (size > byteLimit) throw DragFailure("PAYLOAD_TOO_LARGE", id)
            val output = ByteArrayOutputStream()
            source.inputStream().use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    if (isCancelled()) throw DragFailure("CANCELLED", id)
                    val count = input.read(buffer, 0, minOf(buffer.size, byteLimit - output.size() + 1))
                    if (count < 0) break
                    if (output.size() + count > byteLimit) throw DragFailure("PAYLOAD_TOO_LARGE", id)
                    output.write(buffer, 0, count)
                }
            }
            if (source.length() != size || source.lastModified() != modified || output.size().toLong() != size) {
                throw DragFailure("SOURCE_CHANGED", id)
            }
            val bytes = output.toByteArray()
            val text = try {
                Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
            } catch (error: Exception) { throw DragFailure("INVALID_TEXT", id) }
            if (legacySizeCandidate && expectedSize != text.length.toLong()) throw DragFailure("SOURCE_CHANGED", id)
            // 首页和历史使用 TextProfile.Hash 校验完整内容，与是否提供字节元数据无关。
            if (id.matches(CONTENT_HASH_ID)) {
                val hash = MessageDigest.getInstance("SHA-256").digest(bytes).toLowerHex()
                if (!id.equals(hash, ignoreCase = true)) {
                    // 旧存储客户端下载无 hash 文本时，使用了含文件名的 FileProfile 哈希。
                    val legacyIdentity = "${source.name}|${hash.uppercase()}".toByteArray(Charsets.UTF_8)
                    val legacyHash = MessageDigest.getInstance("SHA-256").digest(legacyIdentity).toLowerHex()
                    if (!id.equals(legacyHash, ignoreCase = true)) throw DragFailure("SOURCE_CHANGED", id)
                }
            }
            return text
        }
    }
}

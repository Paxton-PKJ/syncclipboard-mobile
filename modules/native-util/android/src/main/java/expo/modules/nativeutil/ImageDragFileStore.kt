package expo.modules.nativeutil

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** 拖拽使用独立快照，避免剪贴板缓存清理使接收应用的 URI 失效。 */
internal object ImageDragFileStore {
    private const val RETENTION_MS = 24 * 60 * 60 * 1000L
    private const val MAX_CACHE_BYTES = 200 * 1024 * 1024L
    private val activeFiles = ConcurrentHashMap.newKeySet<String>()

    data class Snapshot(val file: File, val uri: Uri, val mimeType: String)

    fun prepare(context: Context, fileUri: String, expectedSize: Long?, isCancelled: () -> Boolean = { false }, itemId: String? = null): Snapshot {
        fun checkCancelled() { if (isCancelled()) throw DragFailure("CANCELLED") }
        checkCancelled()
        val uri = Uri.parse(fileUri)
        if (uri.scheme != "file" || !uri.authority.isNullOrEmpty() || uri.path == null) throw DragFailure("ITEM_NOT_READY", itemId)
        val source = runCatching { File(uri.path!!).canonicalFile }.getOrElse { throw DragFailure("ITEM_NOT_READY", itemId) }
        if (!source.isFile || !source.canRead() || source.length() <= 0) throw DragFailure("ITEM_NOT_READY", itemId)
        val size = source.length()
        val modified = source.lastModified()
        if (expectedSize != null && expectedSize > 0 && expectedSize != size) throw DragFailure("SOURCE_CHANGED", itemId)

        val directory = File(context.cacheDir, ".native_util_drag")
        if (!directory.isDirectory && !directory.mkdirs()) throw DragFailure("ITEM_NOT_READY", itemId)
        cleanupDirectory(directory, reserveBytes = size)
        val target = File(directory, UUID.randomUUID().toString())
        activeFiles.add(target.absolutePath)
        try {
            source.inputStream().use { input -> target.outputStream().use { output ->
                val buffer = ByteArray(8192)
                while (true) {
                    checkCancelled()
                    val count = input.read(buffer)
                    if (count < 0) break
                    output.write(buffer, 0, count)
                }
            } }
            checkCancelled()
            if (target.length() != size || source.length() != size || source.lastModified() != modified) throw DragFailure("SOURCE_CHANGED", itemId)
            // 只读取图片头，不解码全尺寸位图。使用实际数据的 MIME，拒绝伪装成图片的文件。
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(target.absolutePath, bounds)
            val mime = bounds.outMimeType
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || mime == null || !mime.startsWith("image/")) throw DragFailure("INVALID_IMAGE", itemId)
            val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: "img"
            val imageFile = File(directory, "${target.name}.$extension")
            activeFiles.add(imageFile.absolutePath)
            if (!target.renameTo(imageFile)) {
                activeFiles.remove(imageFile.absolutePath)
                throw DragFailure("ITEM_NOT_READY", itemId)
            }
            activeFiles.remove(target.absolutePath)
            try {
                val contentUri = FileProvider.getUriForFile(context, "${context.packageName}.NativeUtilFileProvider", imageFile)
                return Snapshot(imageFile, contentUri, mime)
            } catch (error: Exception) {
                imageFile.delete()
                activeFiles.remove(imageFile.absolutePath)
                throw error
            }
        } catch (error: Exception) {
            target.delete()
            activeFiles.remove(target.absolutePath)
            if (error is DragFailure) throw error
            throw DragFailure("ITEM_NOT_READY", itemId)
        }
    }

    fun release(snapshot: Snapshot) {
        // 从拖拽结束计时，给目标应用时间读取；启动、后台切换和下次拖拽时清理。
        if (activeFiles.remove(snapshot.file.absolutePath)) snapshot.file.setLastModified(System.currentTimeMillis())
    }

    fun discard(snapshot: Snapshot) {
        activeFiles.remove(snapshot.file.absolutePath)
        snapshot.file.delete()
    }

    fun cleanup(context: Context) = cleanupDirectory(File(context.cacheDir, ".native_util_drag"))

    internal fun cleanupDirectory(directory: File, maxBytes: Long = MAX_CACHE_BYTES, reserveBytes: Long = 0, now: Long = System.currentTimeMillis()) {
        if (reserveBytes > maxBytes) throw DragFailure("PAYLOAD_TOO_LARGE")
        val files = directory.listFiles()?.filter { it.isFile } ?: emptyList()
        files.filter { it.absolutePath !in activeFiles && now - it.lastModified() > RETENTION_MS }.forEach { it.delete() }
        val remaining = files.filter { it.exists() }
        var total = remaining.sumOf { it.length() }
        remaining.filter { it.absolutePath !in activeFiles }.sortedBy { it.lastModified() }.forEach { file ->
            if (total + reserveBytes > maxBytes) {
                val size = file.length()
                if (file.delete()) total -= size
            }
        }
        // 活跃拖拽不可撤销 URI；如果仍没有空间，拒绝新快照。
        if (total + reserveBytes > maxBytes) throw DragFailure("PAYLOAD_TOO_LARGE")
    }
}

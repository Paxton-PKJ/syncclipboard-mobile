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
    private val activeFiles = ConcurrentHashMap.newKeySet<String>()

    data class Snapshot(val file: File, val uri: Uri, val mimeType: String)

    fun prepare(context: Context, fileUri: String, expectedSize: Long?, isCancelled: () -> Boolean = { false }): Snapshot {
        fun checkCancelled() { if (isCancelled()) throw HistoryDragFailure("CANCELLED") }
        checkCancelled()
        val uri = Uri.parse(fileUri)
        require(uri.scheme == "file" && uri.authority.isNullOrEmpty()) { "Local file URI required" }
        val source = File(requireNotNull(uri.path)).canonicalFile
        require(source.isFile && source.canRead() && source.length() > 0) { "Image not ready" }
        val size = source.length()
        val modified = source.lastModified()
        require(expectedSize == null || expectedSize <= 0 || expectedSize == size) { "Incomplete image" }

        val directory = File(context.cacheDir, ".native_util_drag")
        check(directory.isDirectory || directory.mkdirs()) { "Drag cache unavailable" }
        directory.listFiles()?.forEach {
            if (it.absolutePath !in activeFiles && System.currentTimeMillis() - it.lastModified() > RETENTION_MS) {
                it.delete()
            }
        }
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
            check(target.length() == size && source.length() == size && source.lastModified() == modified) {
                "Image changed while preparing drag"
            }
            // 只读取图片头，不解码全尺寸位图。使用实际数据的 MIME，拒绝伪装成图片的文件。
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(target.absolutePath, bounds)
            val mime = bounds.outMimeType
            require(bounds.outWidth > 0 && bounds.outHeight > 0 && mime != null && mime.startsWith("image/")) {
                "Invalid image"
            }
            val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: "img"
            val imageFile = File(directory, "${target.name}.$extension")
            activeFiles.add(imageFile.absolutePath)
            if (!target.renameTo(imageFile)) {
                activeFiles.remove(imageFile.absolutePath)
                error("Cannot finalize drag image")
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
            throw error
        }
    }

    fun release(snapshot: Snapshot) {
        // 从拖拽结束计时，给目标应用时间读取；下一次拖拽时才清理过期快照。
        if (activeFiles.remove(snapshot.file.absolutePath)) snapshot.file.setLastModified(System.currentTimeMillis())
    }

    fun discard(snapshot: Snapshot) {
        activeFiles.remove(snapshot.file.absolutePath)
        snapshot.file.delete()
    }
}

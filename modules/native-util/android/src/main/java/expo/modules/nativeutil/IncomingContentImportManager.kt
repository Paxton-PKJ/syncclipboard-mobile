package expo.modules.nativeutil

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

data class IncomingSessionMeta(
    val sessionId: String,
    val kind: String,
    val itemCount: Int,
    val previewText: String? = null
) {
    fun toMap(): Map<String, Any> = buildMap {
        put("sessionId", sessionId)
        put("kind", kind)
        put("itemCount", itemCount)
        if (previewText != null) put("previewText", previewText)
    }

    fun toBundle(): Bundle = Bundle().apply {
        putString("sessionId", sessionId)
        putString("kind", kind)
        putInt("itemCount", itemCount)
        if (previewText != null) putString("previewText", previewText)
    }
}

data class StagedIncomingFile(
    val uri: String,
    val fileName: String,
    val mimeType: String,
    val size: Long
) {
    fun toMap(): Map<String, Any> = mapOf(
        "uri" to uri,
        "fileName" to fileName,
        "mimeType" to mimeType,
        "size" to size.toDouble()
    )
}

data class IncomingSessionResult(
    val sessionId: String,
    val type: String,
    val text: String? = null,
    val file: StagedIncomingFile? = null,
    val files: List<StagedIncomingFile> = emptyList(),
    val mimeType: String? = null
) {
    fun toMap(): Map<String, Any> = buildMap {
        put("sessionId", sessionId)
        put("type", type)
        if (text != null) put("text", text)
        if (file != null) put("file", file.toMap())
        if (files.isNotEmpty()) put("files", files.map { it.toMap() })
        if (mimeType != null) put("mimeType", mimeType)
    }
}

/**
 * 共享外部内容（系统分享 / 系统拖放）的后台导入与暂存管理器。
 * 所有 content:// 流式拷贝、MIME 嗅探和权限释放都在独立会话目录内异步执行，
 * 避免在主线程阻塞或因过早释放 URI 权限导致读取失败。
 */
object IncomingContentImportManager {
    const val ORIGIN_SHARE = "share"
    const val ORIGIN_DROP = "drop"
    const val KIND_EMPTY = "empty"
    const val KIND_UNSUPPORTED_MIXED = "unsupported_mixed"

    private const val TAG = "IncomingContentImport"
    private const val CACHE_DIR_NAME = ".incoming_transfer"
    private const val COPY_BUFFER_SIZE = 64 * 1024
    private const val PROGRESS_INTERVAL_MS = 250L
    private const val STALE_RETENTION_MS = 60 * 60 * 1000L

    interface EventBridge {
        fun onProgress(payload: Map<String, Any>)
        fun onShareSession(payload: Map<String, Any>)
    }

    private data class SessionRecord(
        val sessionId: String,
        val origin: String,
        val sessionDir: File?,
        val cancelFlag: AtomicBoolean,
        val future: CompletableFuture<Any>
    )

    private val ioExecutor = Executors.newCachedThreadPool()
    private val sessions = ConcurrentHashMap<String, SessionRecord>()
    private val eventBridges = CopyOnWriteArraySet<EventBridge>()

    @Volatile
    private var activeShareSession: IncomingSessionMeta? = null

    fun addEventBridge(bridge: EventBridge) {
        eventBridges.add(bridge)
    }

    fun removeEventBridge(bridge: EventBridge) {
        eventBridges.remove(bridge)
    }

    fun getActiveShareSessionMap(): Map<String, Any>? = activeShareSession?.toMap()

    fun clearActiveShareSessionIfMatches(sessionId: String) {
        val current = activeShareSession
        if (current != null && current.sessionId == sessionId) {
            activeShareSession = null
        }
    }

    fun startSession(
        context: Context,
        source: ParsedIncomingSource,
        sourceOrigin: String,
        readGrantUris: Set<Uri>,
        notifyShareEvent: Boolean = false,
        onReleasePermissions: (() -> Unit)? = null
    ): IncomingSessionMeta {
        val appContext = context.applicationContext
        if (
            source.kind == ParsedIncomingSource.Kind.EMPTY ||
            source.kind == ParsedIncomingSource.Kind.UNSUPPORTED_MIXED
        ) {
            runCatching { onReleasePermissions?.invoke() }
            val rejectedKind = if (source.kind == ParsedIncomingSource.Kind.UNSUPPORTED_MIXED) {
                KIND_UNSUPPORTED_MIXED
            } else {
                KIND_EMPTY
            }
            val rejectedMeta = IncomingSessionMeta(sessionId = "", kind = rejectedKind, itemCount = 0)
            if (sourceOrigin == ORIGIN_SHARE) {
                activeShareSession = null
                if (notifyShareEvent) {
                    emitShareSession(rejectedMeta.toMap())
                }
            }
            return rejectedMeta
        }

        val sessionId = UUID.randomUUID().toString()
        val cancelFlag = AtomicBoolean(false)
        val future = CompletableFuture<Any>()

        val meta = when (source.kind) {
            ParsedIncomingSource.Kind.TEXT -> IncomingSessionMeta(
                sessionId = sessionId,
                kind = "text",
                itemCount = 1,
                previewText = source.text?.take(100)
            )
            ParsedIncomingSource.Kind.FILE -> IncomingSessionMeta(
                sessionId = sessionId,
                kind = "file",
                itemCount = 1
            )
            ParsedIncomingSource.Kind.MULTIPLE -> IncomingSessionMeta(
                sessionId = sessionId,
                kind = "multiple",
                itemCount = source.uris.size
            )
            ParsedIncomingSource.Kind.UNSUPPORTED_MIXED,
            ParsedIncomingSource.Kind.EMPTY -> {
                runCatching { onReleasePermissions?.invoke() }
                return IncomingSessionMeta(sessionId = "", kind = KIND_EMPTY, itemCount = 0)
            }
        }

        if (source.kind == ParsedIncomingSource.Kind.TEXT) {
            val result = IncomingSessionResult(
                sessionId = sessionId,
                type = "text",
                text = source.text ?: "",
                mimeType = "text/plain"
            )
            future.complete(result)
            sessions[sessionId] = SessionRecord(
                sessionId = sessionId,
                origin = sourceOrigin,
                sessionDir = null,
                cancelFlag = cancelFlag,
                future = future
            )
            runCatching { onReleasePermissions?.invoke() }
            if (sourceOrigin == ORIGIN_SHARE) {
                activeShareSession = meta
                if (notifyShareEvent) {
                    emitShareSession(meta.toMap())
                }
            }
            return meta
        }

        val rootDir = File(appContext.cacheDir, CACHE_DIR_NAME)
        val sessionDir = File(rootDir, sessionId)
        val record = SessionRecord(
            sessionId = sessionId,
            origin = sourceOrigin,
            sessionDir = sessionDir,
            cancelFlag = cancelFlag,
            future = future
        )
        sessions[sessionId] = record

        if (sourceOrigin == ORIGIN_SHARE) {
            activeShareSession = meta
            if (notifyShareEvent) {
                emitShareSession(meta.toMap())
            }
        }

        ioExecutor.execute {
            stageUris(
                appContext = appContext,
                record = record,
                source = source,
                readGrantUris = readGrantUris,
                onReleasePermissions = onReleasePermissions
            )
        }

        return meta
    }

    fun awaitSession(sessionId: String, promise: Promise) {
        val record = sessions[sessionId]
        if (record == null) {
            promise.reject(IncomingSessionNotFoundException(sessionId))
            return
        }

        ioExecutor.execute {
            try {
                when (val outcome = record.future.get()) {
                    is IncomingSessionResult -> promise.resolve(outcome.toMap())
                    is CodedException -> promise.reject(outcome)
                    else -> promise.reject(
                        IncomingImportException("Unexpected incoming session result")
                    )
                }
            } catch (e: Exception) {
                promise.reject(
                    IncomingImportException(e.message ?: "Failed to prepare incoming content", e)
                )
            }
        }
    }

    fun cancelSession(sessionId: String) {
        val record = sessions[sessionId] ?: return
        record.cancelFlag.set(true)
        if (record.future.complete(CancelledException())) {
            clearActiveShareSessionIfMatches(sessionId)
            record.sessionDir?.let { dir ->
                ioExecutor.execute { runCatching { dir.deleteRecursively() } }
            }
        }
    }

    fun cleanupSession(sessionId: String) {
        if (sessionId.isEmpty()) return
        clearActiveShareSessionIfMatches(sessionId)
        val record = sessions.remove(sessionId) ?: return
        record.cancelFlag.set(true)
        record.future.complete(CancelledException())
        record.sessionDir?.let { dir ->
            ioExecutor.execute { runCatching { dir.deleteRecursively() } }
        }
    }

    fun cleanupStaleSessions(context: Context) {
        val rootDir = File(context.applicationContext.cacheDir, CACHE_DIR_NAME)
        ioExecutor.execute {
            runCatching {
                if (!rootDir.isDirectory) return@runCatching
                val now = System.currentTimeMillis()
                val activeIds = sessions.keys
                rootDir.listFiles()?.forEach { child ->
                    if (child.name !in activeIds && now - child.lastModified() > STALE_RETENTION_MS) {
                        child.deleteRecursively()
                    }
                }
            }
        }
    }

    private fun stageUris(
        appContext: Context,
        record: SessionRecord,
        source: ParsedIncomingSource,
        readGrantUris: Set<Uri>,
        onReleasePermissions: (() -> Unit)?
    ) {
        val sessionDir = record.sessionDir
        val contentResolver = appContext.contentResolver
        try {
            if (sessionDir == null || (!sessionDir.exists() && !sessionDir.mkdirs())) {
                throw IOException("Failed to create staging directory")
            }

            val uris = source.uris
            val totalFiles = uris.size
            val usedNames = HashMap<String, Int>()
            val stagedFiles = ArrayList<StagedIncomingFile>(totalFiles)
            val fallbackPrefix = if (record.origin == ORIGIN_DROP) "dropped" else "shared"

            for (index in uris.indices) {
                if (record.cancelFlag.get()) {
                    throw CancelledSignal()
                }

                val uri = uris[index]
                validateIncomingUri(appContext, uri, readGrantUris)
                val resolvedMime = resolveInitialMimeType(contentResolver, uri, source.declaredMimeType)
                val initialName = IncomingContentParser.resolveFileName(
                    contentResolver = contentResolver,
                    uri = uri,
                    mimeType = resolvedMime,
                    fallbackPrefix = fallbackPrefix
                )
                val deduplicatedName = IncomingContentParser.deduplicateFileName(initialName, usedNames)
                val destFile = File(sessionDir, deduplicatedName)
                val expectedBytes = queryContentSize(contentResolver, uri)

                val copiedBytes = copyUriToFile(
                    contentResolver = contentResolver,
                    uri = uri,
                    destFile = destFile,
                    expectedBytes = expectedBytes,
                    sessionId = record.sessionId,
                    currentFile = index + 1,
                    totalFiles = totalFiles,
                    cancelFlag = record.cancelFlag
                )

                val refinedMime = refineMimeType(destFile, resolvedMime)
                val finalFile = appendMissingExtensionIfNeeded(destFile, refinedMime, usedNames)
                val finalSize = finalFile.length().takeIf { it > 0 } ?: copiedBytes

                stagedFiles.add(
                    StagedIncomingFile(
                        uri = Uri.fromFile(finalFile).toString(),
                        fileName = finalFile.name,
                        mimeType = refinedMime,
                        size = finalSize
                    )
                )
            }

            if (record.cancelFlag.get()) {
                throw CancelledSignal()
            }

            val result = if (source.kind == ParsedIncomingSource.Kind.FILE) {
                val single = stagedFiles.first()
                IncomingSessionResult(
                    sessionId = record.sessionId,
                    type = "file",
                    file = single,
                    mimeType = single.mimeType
                )
            } else {
                IncomingSessionResult(
                    sessionId = record.sessionId,
                    type = "multiple",
                    files = stagedFiles
                )
            }

            if (!record.future.complete(result)) {
                runCatching { sessionDir.deleteRecursively() }
            }
        } catch (_: CancelledSignal) {
            runCatching { sessionDir?.deleteRecursively() }
            record.future.complete(CancelledException())
        } catch (e: Exception) {
            NativeLogger.e(TAG, "Staging failed for session ${record.sessionId}", e)
            runCatching { sessionDir?.deleteRecursively() }
            if (record.cancelFlag.get()) {
                record.future.complete(CancelledException())
            } else {
                record.future.complete(
                    IncomingImportException(e.message ?: "Failed to stage incoming files", e)
                )
            }
        } finally {
            runCatching { onReleasePermissions?.invoke() }
        }
    }

    private fun resolveInitialMimeType(
        contentResolver: ContentResolver,
        uri: Uri,
        declaredMimeType: String?
    ): String? {
        val resolverType = runCatching {
            IncomingContentParser.normalizeMimeType(contentResolver.getType(uri))
        }.getOrNull()
        if (!IncomingContentParser.isGenericMimeType(resolverType)) {
            return resolverType
        }
        val normalizedDeclared = IncomingContentParser.normalizeMimeType(declaredMimeType)
        if (!IncomingContentParser.isGenericMimeType(normalizedDeclared)) {
            return normalizedDeclared
        }
        return resolverType ?: normalizedDeclared
    }

    private fun queryContentSize(contentResolver: ContentResolver, uri: Uri): Long {
        return runCatching {
            contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                val idx = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (cursor.moveToFirst() && idx >= 0 && !cursor.isNull(idx)) cursor.getLong(idx) else -1L
            } ?: -1L
        }.getOrDefault(-1L)
    }

    private fun copyUriToFile(
        contentResolver: ContentResolver,
        uri: Uri,
        destFile: File,
        expectedBytes: Long,
        sessionId: String,
        currentFile: Int,
        totalFiles: Int,
        cancelFlag: AtomicBoolean
    ): Long {
        val inputStream = contentResolver.openInputStream(uri)
            ?: throw IOException("Cannot open input stream for URI: $uri")

        var lastReportTime = 0L
        val bytesCopied = inputStream.use { input ->
            FileOutputStream(destFile).use { output ->
                copyIncomingStream(input, output, expectedBytes) { count ->
                    if (cancelFlag.get()) throw CancelledSignal()
                    val now = System.currentTimeMillis()
                    if (now - lastReportTime >= PROGRESS_INTERVAL_MS) {
                        lastReportTime = now
                        emitProgress(sessionId, currentFile, totalFiles, count, expectedBytes)
                    }
                }
            }
        }

        val finalTotal = if (expectedBytes > 0) expectedBytes else bytesCopied
        emitProgress(sessionId, currentFile, totalFiles, bytesCopied, finalTotal)
        return bytesCopied
    }

    internal fun copyIncomingStream(
        input: InputStream,
        output: OutputStream,
        expectedBytes: Long,
        onProgress: (Long) -> Unit
    ): Long {
        val buffer = ByteArray(COPY_BUFFER_SIZE)
        var count = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            count += read
            if (expectedBytes >= 0 && count > expectedBytes) throw IOException("Incoming file exceeds its declared size")
            onProgress(count)
            output.write(buffer, 0, read)
        }
        if (expectedBytes >= 0 && count != expectedBytes) throw IOException("Incoming file is shorter than its declared size")
        return count
    }

    private fun validateIncomingUri(context: Context, uri: Uri, readGrantUris: Set<Uri>) {
        validateIncomingUriComponents(
            scheme = uri.scheme,
            rawAuthority = uri.authority,
            ownPackageName = context.packageName,
            hasReadGrant = uri in readGrantUris && context.checkUriPermission(
                uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION
            ) == PackageManager.PERMISSION_GRANTED,
            resolveProviderPackage = { authority ->
                val providerInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    context.packageManager.resolveContentProvider(
                        authority,
                        PackageManager.ComponentInfoFlags.of(0)
                    )
                } else {
                    @Suppress("DEPRECATION")
                    context.packageManager.resolveContentProvider(authority, 0)
                }
                providerInfo?.packageName
            }
        )
    }

    internal fun validateIncomingUriComponents(
        scheme: String?,
        rawAuthority: String?,
        ownPackageName: String,
        hasReadGrant: Boolean,
        resolveProviderPackage: (String) -> String?
    ) {
        if (scheme != ContentResolver.SCHEME_CONTENT || !hasReadGrant) {
            throw SecurityException("Incoming file requires a content URI with a read grant")
        }
        val authority = rawAuthority?.substringAfterLast('@')?.trim().orEmpty()
        if (authority.isEmpty()) throw SecurityException("Content URI has no authority")
        if (authority.equals(ownPackageName, ignoreCase = true) ||
            authority.startsWith("$ownPackageName.", ignoreCase = true) ||
            resolveProviderPackage(authority).equals(ownPackageName, ignoreCase = true)
        ) {
            throw SecurityException("Access to app private content provider is denied")
        }
    }

    private fun refineMimeType(file: File, initialMimeType: String?): String {
        val normalizedInitial = IncomingContentParser.normalizeMimeType(initialMimeType)
        val shouldSniffImage = IncomingContentParser.isGenericMimeType(normalizedInitial) ||
            normalizedInitial?.startsWith("image/") == true

        if (shouldSniffImage) {
            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.absolutePath, opts)
            val decodedMime = IncomingContentParser.normalizeMimeType(opts.outMimeType)
            if (
                opts.outWidth > 0 &&
                opts.outHeight > 0 &&
                decodedMime != null &&
                decodedMime.startsWith("image/")
            ) {
                return decodedMime
            }
        }

        if (!IncomingContentParser.isGenericMimeType(normalizedInitial) && normalizedInitial != null) {
            return normalizedInitial
        }

        val ext = file.extension.lowercase()
        if (ext.isNotEmpty()) {
            val byExt = IncomingContentParser.normalizeMimeType(
                MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
            )
            if (!IncomingContentParser.isGenericMimeType(byExt) && byExt != null) {
                return byExt
            }
        }

        return "application/octet-stream"
    }

    private fun appendMissingExtensionIfNeeded(
        file: File,
        mimeType: String,
        usedNames: MutableMap<String, Int>
    ): File {
        if (file.name.contains('.')) return file
        val ext = IncomingContentParser.extensionForMime(mimeType)
        if (ext.isEmpty()) return file

        val candidateName = IncomingContentParser.deduplicateFileName("${file.name}$ext", usedNames)
        val parent = file.parentFile ?: return file
        val renamed = File(parent, candidateName)
        return if (file.renameTo(renamed)) renamed else file
    }

    private fun emitProgress(
        sessionId: String,
        currentFile: Int,
        totalFiles: Int,
        bytesCopied: Long,
        totalBytes: Long
    ) {
        val payload: Map<String, Any> = mapOf(
            "sessionId" to sessionId,
            "currentFile" to currentFile,
            "totalFiles" to totalFiles,
            "bytesCopied" to bytesCopied.toDouble(),
            "totalBytes" to totalBytes.toDouble()
        )
        for (bridge in eventBridges) {
            bridge.onProgress(payload)
        }
    }

    private fun emitShareSession(payload: Map<String, Any>) {
        for (bridge in eventBridges) {
            bridge.onShareSession(payload)
        }
    }

    private class CancelledSignal : Exception()
}

class IncomingSessionNotFoundException(sessionId: String) :
    CodedException("Incoming session not found: $sessionId")

class IncomingImportException(message: String, cause: Throwable? = null) :
    CodedException(message, cause)

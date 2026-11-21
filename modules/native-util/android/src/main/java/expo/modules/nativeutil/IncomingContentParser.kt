package expo.modules.nativeutil

import android.content.ClipData
import android.content.ClipDescription
import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.core.content.IntentCompat
import androidx.core.text.HtmlCompat
import java.util.Locale

data class ParsedIncomingSource(
    val kind: Kind,
    val text: String? = null,
    val uris: List<Uri> = emptyList(),
    val declaredMimeType: String? = null
) {
    enum class Kind {
        TEXT,
        FILE,
        MULTIPLE,
        UNSUPPORTED_MIXED,
        EMPTY
    }
}

/**
 * 纯解析层：统一解析来自系统分享 Intent 与系统拖放 ClipData 的内容，
 * 并负责 MIME 归一化、文件名安全消毒与多文件重名去重。
 */
object IncomingContentParser {
    private const val MAX_FILE_NAME_LENGTH = 200

    private val MIME_TO_EXTENSION = mapOf(
        "text/plain" to ".txt",
        "text/html" to ".html",
        "text/css" to ".css",
        "text/javascript" to ".js",
        "application/javascript" to ".js",
        "application/json" to ".json",
        "application/xml" to ".xml",
        "text/xml" to ".xml",
        "application/pdf" to ".pdf",
        "application/zip" to ".zip",
        "application/x-zip-compressed" to ".zip",
        "image/jpeg" to ".jpg",
        "image/jpg" to ".jpg",
        "image/png" to ".png",
        "image/gif" to ".gif",
        "image/webp" to ".webp",
        "image/bmp" to ".bmp",
        "image/heic" to ".heic",
        "image/heif" to ".heif",
        "image/svg+xml" to ".svg",
        "video/mp4" to ".mp4",
        "audio/mpeg" to ".mp3"
    )

    fun parseShareIntent(intent: Intent?): ParsedIncomingSource {
        if (intent == null) return ParsedIncomingSource(ParsedIncomingSource.Kind.EMPTY)
        val action = intent.action ?: return ParsedIncomingSource(ParsedIncomingSource.Kind.EMPTY)
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) {
            return ParsedIncomingSource(ParsedIncomingSource.Kind.EMPTY)
        }

        val declaredMime = normalizeMimeType(intent.type)
        val fileUris = LinkedHashSet<Uri>()
        val urlTexts = ArrayList<String>()

        if (action == Intent.ACTION_SEND) {
            IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let {
                classifyUri(it, fileUris, urlTexts)
            }
        } else {
            IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                ?.forEach { classifyUri(it, fileUris, urlTexts) }
        }

        collectUrisFromClipData(intent.clipData, fileUris, urlTexts)

        if (fileUris.size == 1) {
            return ParsedIncomingSource(
                kind = ParsedIncomingSource.Kind.FILE,
                uris = fileUris.toList(),
                declaredMimeType = declaredMime
            )
        }
        if (fileUris.size > 1) {
            return ParsedIncomingSource(
                kind = ParsedIncomingSource.Kind.MULTIPLE,
                uris = fileUris.toList(),
                declaredMimeType = declaredMime
            )
        }

        val text = extractShareText(intent, action, urlTexts)
        if (text != null) {
            return ParsedIncomingSource(
                kind = ParsedIncomingSource.Kind.TEXT,
                text = text,
                declaredMimeType = declaredMime ?: "text/plain"
            )
        }

        return ParsedIncomingSource(ParsedIncomingSource.Kind.EMPTY)
    }

    fun parseDropClipData(clipData: ClipData?): ParsedIncomingSource {
        if (clipData == null || clipData.itemCount == 0) {
            return ParsedIncomingSource(ParsedIncomingSource.Kind.EMPTY)
        }

        val declaredMime = extractSingleDeclaredMime(clipData.description)
        val fileUris = LinkedHashSet<Uri>()
        val texts = ArrayList<String>()

        for (index in 0 until clipData.itemCount) {
            val item = clipData.getItemAt(index) ?: continue
            val uri = item.uri
            if (uri != null) {
                classifyUri(uri, fileUris, texts)
            } else {
                extractTextFromClipItem(item)?.let { texts.add(it) }
            }
        }

        return when (classifyDropItems(fileUris.size, texts)) {
            ParsedIncomingSource.Kind.UNSUPPORTED_MIXED -> ParsedIncomingSource(
                kind = ParsedIncomingSource.Kind.UNSUPPORTED_MIXED,
                declaredMimeType = declaredMime
            )
            ParsedIncomingSource.Kind.FILE -> ParsedIncomingSource(
                kind = ParsedIncomingSource.Kind.FILE,
                uris = fileUris.toList(),
                declaredMimeType = declaredMime
            )
            ParsedIncomingSource.Kind.MULTIPLE -> ParsedIncomingSource(
                kind = ParsedIncomingSource.Kind.MULTIPLE,
                uris = fileUris.toList(),
                declaredMimeType = declaredMime
            )
            ParsedIncomingSource.Kind.TEXT -> {
                val nonEmptyTexts = texts.filter { it.isNotEmpty() }
                ParsedIncomingSource(
                    kind = ParsedIncomingSource.Kind.TEXT,
                    text = if (nonEmptyTexts.isNotEmpty()) nonEmptyTexts.joinToString("\n") else "",
                    declaredMimeType = declaredMime ?: "text/plain"
                )
            }
            ParsedIncomingSource.Kind.EMPTY -> ParsedIncomingSource(ParsedIncomingSource.Kind.EMPTY)
        }
    }

    internal fun classifyDropItems(
        fileUriCount: Int,
        texts: List<String>
    ): ParsedIncomingSource.Kind {
        if (fileUriCount > 0 && texts.any { it.isNotBlank() }) {
            return ParsedIncomingSource.Kind.UNSUPPORTED_MIXED
        }
        if (fileUriCount == 1) {
            return ParsedIncomingSource.Kind.FILE
        }
        if (fileUriCount > 1) {
            return ParsedIncomingSource.Kind.MULTIPLE
        }
        if (texts.isNotEmpty()) {
            return ParsedIncomingSource.Kind.TEXT
        }
        return ParsedIncomingSource.Kind.EMPTY
    }

    fun canAcceptClipDescription(description: ClipDescription?): Boolean {
        if (description == null || description.mimeTypeCount <= 0) return false
        for (i in 0 until description.mimeTypeCount) {
            if (description.getMimeType(i) != ClipDescription.MIMETYPE_TEXT_INTENT) {
                return true
            }
        }
        return false
    }

    fun normalizeMimeType(mime: String?): String? {
        if (mime == null) return null
        val normalized = mime.substringBefore(';').trim().lowercase(Locale.ROOT)
        return normalized.ifEmpty { null }
    }

    fun isGenericMimeType(mime: String?): Boolean {
        val normalized = normalizeMimeType(mime) ?: return true
        return normalized == "*/*" ||
            normalized == "application/octet-stream" ||
            normalized.endsWith("/*")
    }

    fun extensionForMime(mimeType: String?): String {
        val normalized = normalizeMimeType(mimeType) ?: return ""
        MIME_TO_EXTENSION[normalized]?.let { return it }
        if (isGenericMimeType(normalized)) return ""
        val mapped = MimeTypeMap.getSingleton().getExtensionFromMimeType(normalized)
        return if (!mapped.isNullOrBlank()) ".$mapped" else ""
    }

    fun resolveFileName(
        contentResolver: ContentResolver,
        uri: Uri,
        mimeType: String?,
        fallbackPrefix: String = "shared"
    ): String {
        var rawName: String? = null
        if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
            runCatching {
                contentResolver.query(
                    uri,
                    arrayOf(OpenableColumns.DISPLAY_NAME),
                    null,
                    null,
                    null
                )?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (idx != -1 && !cursor.isNull(idx)) {
                            rawName = cursor.getString(idx)
                        }
                    }
                }
            }
        }

        if (rawName.isNullOrBlank()) {
            val segment = uri.lastPathSegment
            if (!segment.isNullOrBlank()) {
                rawName = segment.substringAfterLast(':')
            }
        }

        return sanitizeFileName(rawName, mimeType, fallbackPrefix)
    }

    fun sanitizeFileName(
        rawName: String?,
        mimeType: String?,
        fallbackPrefix: String = "shared"
    ): String {
        val base = rawName
            ?.substringAfterLast('/')
            ?.substringAfterLast('\\')
            ?.filter { ch -> ch.code >= 0x20 && ch.code != 0x7F }
            ?.replace(Regex("[<>:\"|?*]"), "_")
            ?.trim()
            ?.trimStart('.')
            .orEmpty()

        if (base.isEmpty() || base == "." || base == "..") {
            return "${fallbackPrefix}_${System.currentTimeMillis()}${extensionForMime(mimeType)}"
        }

        val capped = capFileNameLength(base)
        if (!capped.contains('.')) {
            val ext = extensionForMime(mimeType)
            if (ext.isNotEmpty()) {
                return capFileNameLength("$capped$ext")
            }
        }
        return capped
    }

    fun deduplicateFileName(fileName: String, usedNames: MutableMap<String, Int>): String {
        val initialKey = fileName.lowercase(Locale.ROOT)
        val currentCount = usedNames[initialKey]
        if (currentCount == null) {
            usedNames[initialKey] = 1
            return fileName
        }

        var suffix = currentCount + 1
        val dotIndex = fileName.lastIndexOf('.')
        val stem = if (dotIndex > 0) fileName.substring(0, dotIndex) else fileName
        val ext = if (dotIndex > 0) fileName.substring(dotIndex) else ""

        while (true) {
            val candidate = "$stem ($suffix)$ext"
            val candidateKey = candidate.lowercase(Locale.ROOT)
            if (!usedNames.containsKey(candidateKey)) {
                usedNames[initialKey] = suffix
                usedNames[candidateKey] = 1
                return candidate
            }
            suffix++
        }
    }

    private fun capFileNameLength(name: String): String {
        if (name.length <= MAX_FILE_NAME_LENGTH) return name
        val dotIndex = name.lastIndexOf('.')
        if (dotIndex > 0 && name.length - dotIndex <= 16) {
            val ext = name.substring(dotIndex)
            val stemMax = (MAX_FILE_NAME_LENGTH - ext.length).coerceAtLeast(1)
            return name.substring(0, stemMax) + ext
        }
        return name.substring(0, MAX_FILE_NAME_LENGTH)
    }

    private fun classifyUri(uri: Uri, fileUris: MutableSet<Uri>, urlTexts: MutableList<String>) {
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        if (scheme == ContentResolver.SCHEME_CONTENT || scheme == ContentResolver.SCHEME_FILE) {
            fileUris.add(uri)
        } else {
            val str = uri.toString()
            if (str.isNotEmpty()) {
                urlTexts.add(str)
            }
        }
    }

    private fun collectUrisFromClipData(
        clipData: ClipData?,
        fileUris: MutableSet<Uri>,
        urlTexts: MutableList<String>
    ) {
        if (clipData == null) return
        for (index in 0 until clipData.itemCount) {
            val item = clipData.getItemAt(index) ?: continue
            item.uri?.let { classifyUri(it, fileUris, urlTexts) }
        }
    }

    private fun extractShareText(
        intent: Intent,
        action: String,
        urlTexts: List<String>
    ): String? {
        if (action == Intent.ACTION_SEND_MULTIPLE) {
            val extraTexts = intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT)
                ?.mapNotNull { it?.toString() }
            if (!extraTexts.isNullOrEmpty()) {
                val nonEmpty = extraTexts.filter { it.isNotEmpty() }
                if (nonEmpty.isNotEmpty()) return nonEmpty.joinToString("\n")
            }
        }

        val extraText = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        if (!extraText.isNullOrEmpty()) {
            return extraText
        }

        val clipTexts = extractTextsFromClipData(intent.clipData)
        val nonEmptyClipTexts = clipTexts.filter { it.isNotEmpty() }
        if (nonEmptyClipTexts.isNotEmpty()) {
            return nonEmptyClipTexts.joinToString("\n")
        }

        val nonEmptyUrlTexts = urlTexts.filter { it.isNotEmpty() }
        if (nonEmptyUrlTexts.isNotEmpty()) {
            return nonEmptyUrlTexts.joinToString("\n")
        }

        return extraText ?: clipTexts.firstOrNull()
    }

    private fun extractTextsFromClipData(clipData: ClipData?): List<String> {
        if (clipData == null) return emptyList()
        val results = ArrayList<String>()
        for (index in 0 until clipData.itemCount) {
            val item = clipData.getItemAt(index) ?: continue
            extractTextFromClipItem(item)?.let { results.add(it) }
        }
        return results
    }

    private fun extractTextFromClipItem(item: ClipData.Item): String? {
        item.text?.toString()?.let { return it }
        val html = item.htmlText ?: return null
        return HtmlCompat.fromHtml(html, HtmlCompat.FROM_HTML_MODE_COMPACT).toString()
    }

    private fun extractSingleDeclaredMime(description: ClipDescription?): String? {
        if (description == null) return null
        val candidates = ArrayList<String>()
        for (i in 0 until description.mimeTypeCount) {
            val mime = normalizeMimeType(description.getMimeType(i)) ?: continue
            if (mime != "text/uri-list" && mime != ClipDescription.MIMETYPE_TEXT_INTENT) {
                candidates.add(mime)
            }
        }
        return candidates.distinct().singleOrNull()
    }
}

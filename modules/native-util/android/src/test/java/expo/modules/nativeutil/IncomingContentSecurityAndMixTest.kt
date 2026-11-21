package expo.modules.nativeutil

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class IncomingContentSecurityAndMixTest {
    private val ownPkg = "com.jericx.syncclipboardmobile"
    private val privateDirs = listOf(
        "/data/user/0/$ownPkg",
        "/data/user_de/0/$ownPkg",
        "/data/data/$ownPkg"
    )

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
    fun `rejects own-app content provider URIs before metadata or stream access`() {
        assertThrows(SecurityException::class.java) {
            IncomingContentImportManager.validateIncomingUriComponents(
                scheme = "content",
                rawAuthority = "$ownPkg.NativeUtilFileProvider",
                canonicalFilePath = null,
                ownPackageName = ownPkg,
                ownPrivateDirs = privateDirs,
                resolveProviderPackage = { ownPkg }
            )
        }

        // Cross-user authority form (userId@authority)
        assertThrows(SecurityException::class.java) {
            IncomingContentImportManager.validateIncomingUriComponents(
                scheme = "content",
                rawAuthority = "10@$ownPkg.FileSystemFileProvider",
                canonicalFilePath = null,
                ownPackageName = ownPkg,
                ownPrivateDirs = privateDirs,
                resolveProviderPackage = { ownPkg }
            )
        }

        // Fallback when PackageManager returns null for an authority prefixed with own package
        assertThrows(SecurityException::class.java) {
            IncomingContentImportManager.validateIncomingUriComponents(
                scheme = "content",
                rawAuthority = "$ownPkg.customprovider",
                canonicalFilePath = null,
                ownPackageName = ownPkg,
                ownPrivateDirs = privateDirs,
                resolveProviderPackage = { null }
            )
        }

        // Different authority name owned by our package
        assertThrows(SecurityException::class.java) {
            IncomingContentImportManager.validateIncomingUriComponents(
                scheme = "content",
                rawAuthority = "org.alias.internal.provider",
                canonicalFilePath = null,
                ownPackageName = ownPkg,
                ownPrivateDirs = privateDirs,
                resolveProviderPackage = { ownPkg }
            )
        }

        // Empty authority
        assertThrows(SecurityException::class.java) {
            IncomingContentImportManager.validateIncomingUriComponents(
                scheme = "content",
                rawAuthority = "  ",
                canonicalFilePath = null,
                ownPackageName = ownPkg,
                ownPrivateDirs = privateDirs,
                resolveProviderPackage = { null }
            )
        }
    }

    @Test
    fun `allows external third-party content providers and rejects app private file dirs`() {
        IncomingContentImportManager.validateIncomingUriComponents(
            scheme = "content",
            rawAuthority = "com.android.providers.media.documents",
            canonicalFilePath = null,
            ownPackageName = ownPkg,
            ownPrivateDirs = privateDirs,
            resolveProviderPackage = { "com.android.providers.media.module" }
        )

        // Third-party provider starting with ownPkg without a dot separator must remain allowed
        IncomingContentImportManager.validateIncomingUriComponents(
            scheme = "content",
            rawAuthority = "${ownPkg}addon.provider",
            canonicalFilePath = null,
            ownPackageName = ownPkg,
            ownPrivateDirs = privateDirs,
            resolveProviderPackage = { "${ownPkg}addon" }
        )

        assertThrows(SecurityException::class.java) {
            IncomingContentImportManager.validateIncomingUriComponents(
                scheme = "file",
                rawAuthority = null,
                canonicalFilePath = "/data/user/0/$ownPkg/files/AsyncStorage",
                ownPackageName = ownPkg,
                ownPrivateDirs = privateDirs,
                resolveProviderPackage = { null }
            )
        }

        assertThrows(SecurityException::class.java) {
            IncomingContentImportManager.validateIncomingUriComponents(
                scheme = "file",
                rawAuthority = null,
                canonicalFilePath = "/data/data/$ownPkg/cache/secret.db",
                ownPackageName = ownPkg,
                ownPrivateDirs = privateDirs,
                resolveProviderPackage = { null }
            )
        }

        IncomingContentImportManager.validateIncomingUriComponents(
            scheme = "file",
            rawAuthority = null,
            canonicalFilePath = "/storage/emulated/0/Download/shared.png",
            ownPackageName = ownPkg,
            ownPrivateDirs = privateDirs,
            resolveProviderPackage = { null }
        )

        assertThrows(SecurityException::class.java) {
            IncomingContentImportManager.validateIncomingUriComponents(
                scheme = "android.resource",
                rawAuthority = ownPkg,
                canonicalFilePath = null,
                ownPackageName = ownPkg,
                ownPrivateDirs = privateDirs,
                resolveProviderPackage = { null }
            )
        }
    }
}

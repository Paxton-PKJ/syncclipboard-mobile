package com.jericx.syncclipboardmobile.share

import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.jericx.syncclipboardmobile.BuildConfig
import expo.modules.ReactActivityDelegateWrapper
import expo.modules.nativeutil.IncomingContentImportManager
import expo.modules.nativeutil.IncomingContentParser
import expo.modules.nativeutil.NativeLogger

/**
 * Transparent Activity for Android share intent.
 * Receives shared content (text, files, images) via SEND / SEND_MULTIPLE intent,
 * delegates file staging to IncomingContentImportManager on a background thread,
 * and renders a semi-transparent overlay via QuickActionApp.
 */
class ShareActivity : ReactActivity() {

    companion object {
        private const val TAG = "ShareActivity"
    }

    private var currentSessionId: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(null)
    }

    override fun getMainComponentName(): String = "quickAction"

    override fun createReactActivityDelegate(): ReactActivityDelegate {
        return ReactActivityDelegateWrapper(
            this,
            BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
            object : DefaultReactActivityDelegate(
                this,
                mainComponentName,
                fabricEnabled
            ) {
                override fun getLaunchOptions(): Bundle {
                    val isDarkMode =
                        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
                            Configuration.UI_MODE_NIGHT_YES
                    val sessionBundle = startShareSession(intent, notifyJs = false)

                    return Bundle().apply {
                        putBoolean("shareMode", true)
                        putString("systemTheme", if (isDarkMode) "dark" else "light")
                        putBundle("shareSession", sessionBundle)
                    }
                }
            }
        )
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        startShareSession(intent, notifyJs = true)
    }

    override fun onDestroy() {
        currentSessionId?.let { IncomingContentImportManager.cleanupSession(it) }
        currentSessionId = null
        super.onDestroy()
    }

    private fun startShareSession(targetIntent: Intent?, notifyJs: Boolean): Bundle {
        val parsed = IncomingContentParser.parseShareIntent(targetIntent)
        NativeLogger.d(
            TAG,
            "Parsed share intent: action=${targetIntent?.action}, type=${targetIntent?.type}, kind=${parsed.kind}, uris=${parsed.uris.size}, notifyJs=$notifyJs"
        )

        val previousSessionId = currentSessionId
        if (!previousSessionId.isNullOrEmpty()) {
            IncomingContentImportManager.cleanupSession(previousSessionId)
        }

        val session = IncomingContentImportManager.startSession(
            context = applicationContext,
            source = parsed,
            sourceOrigin = IncomingContentImportManager.ORIGIN_SHARE,
            notifyShareEvent = notifyJs
        )
        currentSessionId = session.sessionId.takeIf { it.isNotEmpty() }
        return session.toBundle()
    }
}

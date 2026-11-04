package expo.modules.nativeutil

/** 模式只在 DOWN 复制；行回收和 React 更新不会改变会话。 */
internal class HistoryGestureSession(val id: Int, val sourceId: String, val mode: String) {
    var active = false
        private set
    @Volatile var cancelled = false
        private set
    var preparing = false
        private set
    var started = false
    fun activate(): Boolean {
        if (active || cancelled || mode == "disabled") return false
        active = true
        return true
    }
    fun beginPreparing(): Boolean {
        if (!active || cancelled || mode != "drag" || preparing || started) return false
        preparing = true
        return true
    }
    fun cancel() { if (!started) cancelled = true }
}

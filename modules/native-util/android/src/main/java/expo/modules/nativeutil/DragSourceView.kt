package expo.modules.nativeutil

import android.content.Context
import expo.modules.kotlin.AppContext

/** 仅保存命中元数据；识别与会话生命周期由 DragGestureSurfaceView 持有。 */
class DragSourceView(context: Context, appContext: AppContext) : DragHostView(context, appContext) {
    var sourceId: String = ""
    var gestureMode: String = "disabled"
}

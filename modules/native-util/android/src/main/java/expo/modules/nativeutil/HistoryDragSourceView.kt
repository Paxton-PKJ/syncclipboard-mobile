package expo.modules.nativeutil

import android.content.Context
import android.view.View
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/** 仅保存命中元数据；Fabric 独占 React 子视图的布局。 */
class HistoryDragSourceView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    var sourceId: String = ""
    var gestureMode: String = "disabled"
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(View.getDefaultSize(suggestedMinimumWidth, widthMeasureSpec),
            View.getDefaultSize(suggestedMinimumHeight, heightMeasureSpec))
    }
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {}
}

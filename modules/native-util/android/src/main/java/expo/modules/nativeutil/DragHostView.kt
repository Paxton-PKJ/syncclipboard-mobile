package expo.modules.nativeutil

import android.content.Context
import android.view.View
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * 拖拽相关原生视图的共享基类。
 * Fabric 独占 React 子视图的布局，这里只按约束测量自身，不重新布局子视图。
 */
abstract class DragHostView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(View.getDefaultSize(suggestedMinimumWidth, widthMeasureSpec),
            View.getDefaultSize(suggestedMinimumHeight, heightMeasureSpec))
    }
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {}
}

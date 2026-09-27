package engineering.happy.scroll

import com.facebook.react.ReactPackage
import com.facebook.react.ViewManagerOnDemandReactPackage
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManager
import com.facebook.react.views.scroll.ReactScrollView
import com.facebook.react.views.scroll.ReactScrollViewManager

/** The stock vertical ScrollView manager, creating [TransformAwareScrollView] instead. */
class TransformAwareScrollViewManager : ReactScrollViewManager() {
    override fun createViewInstance(context: ThemedReactContext): ReactScrollView =
        TransformAwareScrollView(context)
}

/**
 * Answers for "RCTScrollView", the vertical ScrollView. React Native's bridgeless
 * resolver takes the first on-demand package that answers for a name, so this
 * package has to come before MainReactPackage in the package list;
 * withTransformAwareScrollView inserts it at index 0.
 */
class TransformAwareScrollPackage : ReactPackage, ViewManagerOnDemandReactPackage {
    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<in Nothing, in Nothing>> = listOf(TransformAwareScrollViewManager())

    override fun getViewManagerNames(reactContext: ReactApplicationContext): Collection<String> =
        listOf(ReactScrollViewManager.REACT_CLASS)

    override fun createViewManager(
        reactContext: ReactApplicationContext,
        viewManagerName: String,
    ): ViewManager<in Nothing, in Nothing>? =
        if (viewManagerName == ReactScrollViewManager.REACT_CLASS) TransformAwareScrollViewManager() else null
}

import "react-native-reanimated";
import Transition, {
	type TransitionStackNavigatorTypeBag,
} from "react-native-screen-transitions";
import { withLayoutContext } from "expo-router";

const TransitionableStack = Transition.createTransitionableStackNavigator();

export const Stack = withLayoutContext<
	TransitionStackNavigatorTypeBag["ScreenOptions"],
	typeof TransitionableStack.Navigator,
	TransitionStackNavigatorTypeBag["State"],
	TransitionStackNavigatorTypeBag["EventMap"]
>(TransitionableStack.Navigator);
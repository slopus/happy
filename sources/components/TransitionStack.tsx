import "react-native-reanimated";
import { withLayoutContext } from "expo-router";
import Transition, {
	type TransitionStackNavigatorTypeBag,
} from "react-native-screen-transitions";

const TransitionableStack = Transition.createTransitionableStackNavigator();

export const Stack = withLayoutContext<
	TransitionStackNavigatorTypeBag["ScreenOptions"],
	typeof TransitionableStack.Navigator,
	TransitionStackNavigatorTypeBag["State"],
	TransitionStackNavigatorTypeBag["EventMap"]
>(TransitionableStack.Navigator);

import * as React from 'react';
import { 
    ScrollView, 
    View, 
    StyleProp, 
    ViewStyle,
    Platform,
    ScrollViewProps
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export interface ItemListProps extends ScrollViewProps {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    containerStyle?: StyleProp<ViewStyle>;
    insetGrouped?: boolean;
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.listBackground,
    },
    contentContainer: {
        paddingBottom: Platform.select({ ios: 34, default: 16 }),
        paddingTop: 0,
    },
}));

export const ItemList = React.memo<ItemListProps>((props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    
    const {
        children,
        style,
        containerStyle,
        insetGrouped = true,
        ...scrollViewProps
    } = props;

    const isIOS = Platform.OS === 'ios';
    const isWeb = Platform.OS === 'web';
    
    // Override background for non-inset grouped lists on iOS
    const backgroundColor = (isIOS && !insetGrouped) ? '#FFFFFF' : theme.colors.listBackground;

    return (
        <ScrollView 
            style={[
                styles.container,
                { backgroundColor },
                style
            ]}
            contentContainerStyle={[
                styles.contentContainer,
                containerStyle
            ]}
            showsVerticalScrollIndicator={scrollViewProps.showsVerticalScrollIndicator !== undefined 
                ? scrollViewProps.showsVerticalScrollIndicator 
                : true}
            contentInsetAdjustmentBehavior={(isIOS && !isWeb) ? 'automatic' : undefined}
            {...scrollViewProps}
        >
            {children}
        </ScrollView>
    );
});

export const ItemListStatic = React.memo<Omit<ItemListProps, keyof ScrollViewProps> & {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    containerStyle?: StyleProp<ViewStyle>;
    insetGrouped?: boolean;
}>((props) => {
    const { theme } = useUnistyles();
    
    const {
        children,
        style,
        containerStyle,
        insetGrouped = true
    } = props;

    const isIOS = Platform.OS === 'ios';
    
    // Override background for non-inset grouped lists on iOS
    const backgroundColor = (isIOS && !insetGrouped) ? '#FFFFFF' : theme.colors.listBackground;

    return (
        <View 
            style={[
                { backgroundColor },
                style
            ]}
        >
            <View style={containerStyle}>
                {children}
            </View>
        </View>
    );
});
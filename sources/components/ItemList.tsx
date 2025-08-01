import * as React from 'react';
import { 
    ScrollView, 
    View, 
    StyleProp, 
    ViewStyle,
    Platform,
    ScrollViewProps
} from 'react-native';

export interface ItemListProps extends ScrollViewProps {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    containerStyle?: StyleProp<ViewStyle>;
    insetGrouped?: boolean;
}

export const ItemList = React.memo<ItemListProps>((props) => {
    const {
        children,
        style,
        containerStyle,
        insetGrouped = true,
        ...scrollViewProps
    } = props;

    const isIOS = Platform.OS === 'ios';
    const isWeb = Platform.OS === 'web';
    const backgroundColor = Platform.select({
        ios: isIOS && insetGrouped ? '#F2F2F7' : '#FFFFFF',
        android: '#F5F5F5', // Light grey background
        web: '#F5F5F5', // Match Android styling
        default: '#FFFFFF'
    });

    return (
        <ScrollView 
            style={[
                {
                    flex: 1,
                    backgroundColor,
                },
                style
            ]}
            contentContainerStyle={[
                {
                    paddingBottom: (isIOS && !isWeb) ? 34 : 16,
                    paddingTop: 0,
                },
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
    const {
        children,
        style,
        containerStyle,
        insetGrouped = true
    } = props;

    const isWeb = Platform.OS === 'web';
    const backgroundColor = Platform.select({
        ios: Platform.OS === 'ios' && insetGrouped ? '#F2F2F7' : '#FFFFFF',
        android: '#F5F5F5', // Light grey background
        web: '#F5F5F5', // Match Android styling
        default: '#FFFFFF'
    });

    return (
        <View 
            style={[
                {
                    backgroundColor
                },
                style
            ]}
        >
            <View style={containerStyle}>
                {children}
            </View>
        </View>
    );
});
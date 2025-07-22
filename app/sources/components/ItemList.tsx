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
    const backgroundColor = isIOS && insetGrouped ? '#F2F2F7' : '#FFFFFF';

    return (
        <ScrollView 
            style={[
                {
                    flex: 1,
                    backgroundColor
                },
                style
            ]}
            contentContainerStyle={[
                {
                    paddingBottom: isIOS ? 34 : 16,
                    paddingTop: isIOS && insetGrouped ? 0 : 0
                },
                containerStyle
            ]}
            showsVerticalScrollIndicator={isIOS ? true : scrollViewProps.showsVerticalScrollIndicator}
            contentInsetAdjustmentBehavior={isIOS ? 'automatic' : undefined}
            {...scrollViewProps}
        >
            {children}
        </ScrollView>
    );
});

export const ItemListStatic = React.memo<Omit<ItemListProps, keyof ScrollViewProps>>((props) => {
    const {
        children,
        style,
        containerStyle,
        insetGrouped = true
    } = props;

    const backgroundColor = Platform.OS === 'ios' && insetGrouped ? '#F2F2F7' : '#FFFFFF';

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
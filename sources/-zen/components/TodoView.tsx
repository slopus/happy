import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

export const TODO_HEIGHT = 56;

export type TodoViewProps = {
    done: boolean;
    value: string;
}

export const TodoView = React.memo<TodoViewProps>((props) => {
    const { theme } = useUnistyles();
    return (
        <View style={{ height: TODO_HEIGHT, width: '100%', borderRadius: 4, backgroundColor: theme.colors.surfaceHighest, flexDirection: 'row' }}>
            <View style={{ width: 24, height: 24, backgroundColor: theme.colors.text, borderRadius: 12 }}>

            </View>
            <View style={{ flex: 1, flexDirection: 'row' }}>
                <Text
                    // value={props.value}
                    // onChangeText={props.onValueChange}
                    style={{
                        paddingLeft: 4, paddingRight: 4, paddingTop: 0, paddingBottom: 0,
                        alignSelf: 'center',
                        color: theme.colors.text,
                        fontSize: 18,
                        flexGrow: 1
                    }}
                    numberOfLines={1}
                >
                    {props.value}
                </Text>
            </View>
            {Platform.OS === 'web' && (
                <View
                    style={{
                        width: 48,
                        alignSelf: 'stretch',
                        borderRadius: 4,
                        opacity: 0.5,
                        alignItems: 'center',
                        justifyContent: 'center'
                    }}
                >
                    <MaterialCommunityIcons name="drag" size={24} color={theme.colors.text} />
                </View>
            )}
        </View>
    );
});
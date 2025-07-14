import { SyncMessage } from '@/sync/SyncSession';
import * as React from 'react';
import { View, Text } from 'react-native';

export const MessageView = (props: { message: SyncMessage }) => {
    return (
        <View>
            <Text>{JSON.stringify(props.message)}</Text>
        </View>
    )
}
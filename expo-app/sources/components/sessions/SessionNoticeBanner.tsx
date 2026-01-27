import * as React from 'react';
import { Text, View, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

export type SessionNoticeBannerProps = {
    title: string;
    body: string;
    style?: ViewStyle;
};

export const SessionNoticeBanner = React.memo((props: SessionNoticeBannerProps) => {
    const { theme } = useUnistyles();

    return (
        <View
            style={[
                {
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    borderRadius: 12,
                    backgroundColor: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                },
                props.style,
            ]}
        >
            <Text style={{ color: theme.colors.text, fontSize: 14, fontWeight: '700', marginBottom: 4 }}>
                {props.title}
            </Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 }}>
                {props.body}
            </Text>
        </View>
    );
});


import * as React from 'react';
import { Image, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

export function PersonalAvatar({ uri, size = 30 }: { uri?: string | null; size?: number }) {
    const [failed, setFailed] = React.useState(false);
    const { theme } = useUnistyles();
    React.useEffect(() => setFailed(false), [uri]);
    return <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden', backgroundColor: theme.colors.surfaceHigh }}><Image
        accessibilityIgnoresInvertColors
        onError={() => setFailed(true)}
        source={uri && !failed ? { uri } : require('@/assets/images/paws-mascot.png')}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        resizeMode="cover"
        testID="personal-agent-avatar"
    /></View>;
}

import { Platform, Switch as RNSwitch, SwitchProps } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Deferred } from './Deferred';

export const Switch = (props: SwitchProps) => {
    const { theme } = useUnistyles();
    return (
        <Deferred enabled={Platform.OS === 'android'}> {/* It is not animated on first mount on Android */}
            <RNSwitch
                {...props}
                trackColor={{ false: theme.colors.switch.track.inactive, true: theme.colors.switch.track.active }}
                ios_backgroundColor={theme.colors.switch.track.inactive}
                thumbColor={theme.colors.switch.thumb.active}
                {...{
                    activeThumbColor: theme.colors.switch.thumb.active,
                }}
            />
        </Deferred>
    );
}
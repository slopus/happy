import { Switch as RNSwitch, SwitchProps } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

export const Switch = (props: SwitchProps) => {
    const { theme } = useUnistyles();
    return <RNSwitch {...props} trackColor={{ false: theme.colors.switch.track.inactive, true: theme.colors.switch.track.active }} thumbColor={theme.colors.switch.thumb} />
}
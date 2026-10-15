import { appThemes } from '../../../sources/themePacks';

export const theme = new URLSearchParams(location.search).get('theme') === 'light'
    ? appThemes.caramelLight : appThemes.ginghamDark;
export const StyleSheet = {
    hairlineWidth: 1,
    create: (factory: any) => factory(theme, {
        screen: { width: innerWidth, height: innerHeight },
        insets: { bottom: 0, left: 0, right: 0, top: 0 },
    }),
};
export const useUnistyles = () => ({ theme });

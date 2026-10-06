import { appThemes } from '../../../sources/themePacks';
const name = new URLSearchParams(location.search).get('theme');
export const theme = name === 'light' ? appThemes.caramelLight : appThemes.ginghamDark;
export const StyleSheet = { create: (factory: any) => typeof factory === 'function' ? factory(theme, {}) : factory };
export const useUnistyles = () => ({ theme });

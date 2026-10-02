import React from 'react';
import { Text } from 'react-native';
import { appThemes } from '@/themePacks';
import { zhHans } from '@/text/translations/zh-Hans';
export const theme = appThemes.ginghamDark;
export const StyleSheet = { create: (fn: any) => fn(theme) };
export const useUnistyles = () => ({ theme });
export const Ionicons = ({ name, color, size }: any) => <Text aria-hidden style={{ color, fontSize: size }}>{name === 'trash-outline' ? '⌫' : name === 'create-outline' ? '✎' : '↪'}</Text>;
export const t = (key: string) => key.split('.').reduce((o: any, k) => o?.[k], zhHans) ?? key;

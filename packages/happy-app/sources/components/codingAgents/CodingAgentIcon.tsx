import * as React from 'react';
import { Image } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import { codingAgentBrandIcons } from './brandIcons';
const fallback = {
    gemini: require('@/assets/images/icon-gemini.png'),
    openclaw: require('@/assets/images/icon-openclaw.png'),
};
export function CodingAgentIcon({ agent, size = 22 }: { agent: string; size?: number }) {
    const { theme } = useUnistyles();
    const xml = codingAgentBrandIcons[agent];
    if (xml) return <SvgXml xml={xml.replace(/currentColor/g, theme.colors.text)} width={size} height={size} />;
    const source = fallback[agent as keyof typeof fallback];
    return source ? <Image source={source} style={{ width: size, height: size }} /> : null;
}

import React from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { themeIcons, type SetiTheme } from '@peoplesgrocers/seti-ui-file-icons';
import { useUnistyles } from 'react-native-unistyles';

interface FileIconProps {
    fileName: string;
    size?: number;
}

const lightColorTheme: SetiTheme = {
    blue: '#268bd2',
    grey: '#6b7280',
    'grey-light': '#9ca3af',
    green: '#059669',
    orange: '#d97706',
    pink: '#db2777',
    purple: '#7c3aed',
    red: '#dc2626',
    white: '#374151',
    yellow: '#eab308',
    ignore: '#9ca3af',
};

const darkColorTheme: SetiTheme = {
    blue: '#268bd2',
    grey: '#eee',
    'grey-light': '#839496',
    green: '#4bae4f',
    orange: '#cb4b16',
    pink: '#d33682',
    purple: '#6c71c4',
    red: '#dc322f',
    white: '#fdf6e3',
    yellow: '#ffcb29',
    ignore: '#586e75',
};

export const FileIcon: React.FC<FileIconProps> = ({ 
    fileName, 
    size = 24, 
}) => {
    const { theme } = useUnistyles();
    
    const colorTheme = theme.dark ? darkColorTheme : lightColorTheme;
    const themedGetIcon = themeIcons(colorTheme);
    
    const iconData = themedGetIcon(fileName);
    
    return (
        <View style={{ width: size, height: size }}>
            <SvgXml
                xml={iconData.svg}
                width={size}
                height={size}
                fill={iconData.color}
            />
        </View>
    );
};

export default FileIcon;
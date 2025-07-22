import React from 'react';
import { Text as RNText, TextProps as RNTextProps, StyleProp, TextStyle } from 'react-native';
import { Typography } from '@/constants/Typography';

interface StyledTextProps extends RNTextProps {
  /**
   * Whether to use the default typography. Set to false to skip default font.
   * Useful when you want to use a different typography style.
   */
  useDefaultTypography?: boolean;
}

export const Text: React.FC<StyledTextProps> = ({ 
  style, 
  useDefaultTypography = true, 
  ...props 
}) => {
  const defaultStyle = useDefaultTypography ? Typography.default() : {};
  
  return (
    <RNText 
      style={[defaultStyle, style]} 
      {...props} 
    />
  );
};

// Export the original RNText as well, in case it's needed
export { Text as RNText } from 'react-native'; 
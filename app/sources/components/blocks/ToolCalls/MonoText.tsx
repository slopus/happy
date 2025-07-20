import React from 'react';
import { Text } from '../../StyledText';
import { Typography } from '@/constants/Typography';
import { TextProps as RNTextProps } from 'react-native';

interface MonoTextProps extends RNTextProps {
  // Add any specific props for MonoText if needed
}

export const MonoText: React.FC<MonoTextProps> = ({ style, ...props }) => {
  return (
    <Text 
      useDefaultTypography={false} 
      style={[Typography.mono(), style]} 
      {...props} 
    />
  );
}; 
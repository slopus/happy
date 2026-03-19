import React from 'react';
import { Text as RNText, TextProps as RNTextProps } from 'react-native';
import { Typography } from '@/constants/Typography';

interface StyledTextProps extends RNTextProps {
  /**
   * Whether to use the default typography. Set to false to skip default font.
   * Useful when you want to use a different typography style.
   */
  useDefaultTypography?: boolean;
  /**
   * Whether the text should be selectable. Defaults to false.
   */
  selectable?: boolean;
}

export const Text = React.forwardRef<any, StyledTextProps>(({
  style,
  useDefaultTypography = true,
  selectable = false,
  ...props
}, ref) => {
  const defaultStyle = useDefaultTypography ? Typography.default() : {};

  return (
    <RNText
      ref={ref}
      style={[defaultStyle, style]}
      selectable={selectable}
      {...props}
    />
  );
});

Text.displayName = 'Text';

// Export the original RNText as well, in case it's needed
export { Text as RNText } from 'react-native'; 

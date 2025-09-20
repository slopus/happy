// Global type declarations for Happy Coder project
// This file provides type safety for modules that may not have proper TypeScript declarations

// React Native Vector Icons vendor module
declare module '*/vendor/react-native-vector-icons/lib/create-icon-set' {
  import { ComponentType } from 'react';
  import { TextProps, ImageProps } from 'react-native';

  interface IconProps extends TextProps {
    name: string;
    size?: number;
    color?: string;
  }

  interface IconButtonProps extends IconProps {
    backgroundColor?: string;
    borderRadius?: number;
    iconStyle?: any;
    onPress?: () => void;
  }

  function createIconSet(
    glyphMap: { [key: string]: number },
    fontFamily: string,
    fontFile?: string
  ): {
    (props: IconProps): JSX.Element;
    Button: ComponentType<IconButtonProps>;
    TabBarItem: ComponentType<any>;
    TabBarItemIOS: ComponentType<any>;
    ToolbarAndroid: ComponentType<any>;
    getImageSource: (name: string, size?: number, color?: string) => Promise<ImageProps['source']>;
    getRawGlyphMap: () => { [key: string]: number };
    getFontFamily: () => string;
  };

  export default createIconSet;
}

// Additional module declarations for commonly missing types
declare module '*.png' {
  const value: any;
  export default value;
}

declare module '*.jpg' {
  const value: any;
  export default value;
}

declare module '*.jpeg' {
  const value: any;
  export default value;
}

declare module '*.gif' {
  const value: any;
  export default value;
}

declare module '*.svg' {
  const value: any;
  export default value;
}

declare module '*.json' {
  const value: any;
  export default value;
}

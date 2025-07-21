import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { TOOL_COMPACT_VIEW_STYLES } from '../constants';

export interface ToolIconProps {
  name: keyof typeof Ionicons.glyphMap;
  //failed: boolean
}

export const ToolIcon: React.FC<ToolIconProps> = ({ 
  name, 
  //failed,
}) => {
  // if (failed) {
  //   return (
  //     <Ionicons 
  //       name={name} 
  //       size={16} 
  //       color={TOOL_COMPACT_VIEW_STYLES.ICON_COLOR} 
  //     />
  //   );
  // }
  return (
    <Ionicons 
      name={name} 
      size={16} 
      color={TOOL_COMPACT_VIEW_STYLES.ICON_COLOR} 
    />
  );
}; 
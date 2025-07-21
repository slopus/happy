import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { TOOL_COMPACT_VIEW_STYLES } from '../constants';

export interface ToolIconProps {
  name: keyof typeof Ionicons.glyphMap;
  state?: "running" | "completed" | "error";
}

export const ToolIcon: React.FC<ToolIconProps> = ({ 
  name, 
  state,
}) => {
  if (state === "error") {
    return (
      <Ionicons 
        name="warning" 
        size={TOOL_COMPACT_VIEW_STYLES.ICON_SIZE} 
        color="#ef4444" 
      />
    );
  }
  return (
    <Ionicons 
      name={name} 
      size={16} 
      color={TOOL_COMPACT_VIEW_STYLES.ICON_COLOR} 
    />
  );
}; 
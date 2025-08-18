import React from 'react';
import { Ionicons } from '@expo/vector-icons';

interface FileIconProps {
    fileName?: string;
    isDirectory?: boolean;
    size?: number;
    color?: string;
}

// Get appropriate icon and color based on file extension
function getFileIconConfig(fileName?: string, isDirectory?: boolean) {
    if (isDirectory) {
        return { icon: 'folder' as const, color: '#FFB800' };
    }

    if (!fileName) {
        return { icon: 'document' as const, color: '#666666' };
    }

    const extension = fileName.split('.').pop()?.toLowerCase();
    
    switch (extension) {
        // Code files
        case 'js':
        case 'jsx':
            return { icon: 'logo-javascript' as const, color: '#F7DF1E' };
        case 'ts':
        case 'tsx':
            return { icon: 'logo-javascript' as const, color: '#3178C6' };
        case 'py':
            return { icon: 'logo-python' as const, color: '#3776AB' };
        case 'rb':
            return { icon: 'diamond' as const, color: '#CC342D' };
        case 'go':
            return { icon: 'logo-google' as const, color: '#00ADD8' };
        case 'rs':
            return { icon: 'cog' as const, color: '#CE422B' };
        case 'java':
            return { icon: 'cafe' as const, color: '#007396' };
        case 'cpp':
        case 'c':
        case 'h':
            return { icon: 'code' as const, color: '#00599C' };
        case 'cs':
            return { icon: 'code' as const, color: '#239120' };
        case 'php':
            return { icon: 'code' as const, color: '#777BB4' };
        case 'swift':
            return { icon: 'logo-apple' as const, color: '#FA7343' };
        
        // Web files
        case 'html':
            return { icon: 'logo-html5' as const, color: '#E34C26' };
        case 'css':
            return { icon: 'logo-css3' as const, color: '#1572B6' };
        case 'scss':
        case 'sass':
            return { icon: 'logo-sass' as const, color: '#CC6699' };
        
        // Data files
        case 'json':
            return { icon: 'code-slash' as const, color: '#FFB800' };
        case 'xml':
            return { icon: 'code' as const, color: '#F37C20' };
        case 'yml':
        case 'yaml':
            return { icon: 'settings' as const, color: '#CB171E' };
        
        // Documentation
        case 'md':
        case 'mdx':
            return { icon: 'document-text' as const, color: '#083FA1' };
        case 'txt':
            return { icon: 'document-text' as const, color: '#666666' };
        case 'pdf':
            return { icon: 'document' as const, color: '#FF0000' };
        
        // Images
        case 'png':
        case 'jpg':
        case 'jpeg':
        case 'gif':
        case 'svg':
        case 'webp':
            return { icon: 'image' as const, color: '#40A9FF' };
        
        // Config files
        case 'env':
            return { icon: 'key' as const, color: '#ECD53F' };
        case 'gitignore':
            return { icon: 'git-branch' as const, color: '#F05032' };
        
        // Default
        default:
            return { icon: 'document' as const, color: '#666666' };
    }
}

export function FileIcon({ 
    fileName, 
    isDirectory = false, 
    size = 16, 
    color: customColor
}: FileIconProps) {
    const config = getFileIconConfig(fileName, isDirectory);
    const iconColor = customColor || config.color;
    
    return (
        <Ionicons 
            name={config.icon} 
            size={size} 
            color={iconColor}
        />
    );
}
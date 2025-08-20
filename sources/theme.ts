import { Platform } from 'react-native';

export const lightTheme = {
    dark: false,
    colors: {
        background: '#ffffff',
        primary: '#18171C',
        
        // Item colors
        titleText: '#000000',
        titleSelected: Platform.select({ ios: '#007AFF', default: '#1976D2' }),
        titleDestructive: Platform.select({ ios: '#FF3B30', default: '#F44336' }),
        subtitleText: Platform.select({ ios: '#8E8E93', default: '#49454F' }),
        detailText: Platform.select({ ios: '#8E8E93', default: '#49454F' }),
        chevron: Platform.select({ ios: '#C7C7CC', default: '#49454F' }),
        divider: Platform.select({ ios: '#C6C6C8', default: '#CAC4D0' }),
        pressedOverlay: Platform.select({ ios: '#D1D1D6', default: 'transparent' }),
        ripple: 'rgba(0, 0, 0, 0.08)',
        
        // List colors
        listBackground: Platform.select({ ios: '#F2F2F7', default: '#F5F5F5' }),
        cardBackground: '#FFFFFF',
        headerText: Platform.select({ ios: '#8E8E93', default: '#49454F' }),
        shadowColor: '#000',
        
        // Header colors
        headerBackground: '#FFFFFF',
        headerTint: '#000000',
        headerBorder: 'rgba(0,0,0,0.05)',
        
        // Status colors
        statusConnected: '#34C759',
        statusConnecting: '#007AFF',
        statusDisconnected: '#999999',
        statusError: '#FF3B30',
        statusDefault: '#8E8E93',
        
        // Switch colors
        switchTrackActive: Platform.select({ ios: '#34C759', default: '#1976D2' }),
        switchTrackInactive: '#767577',
        switchThumb: '#FFFFFF',
        
        // FAB colors
        fabBackground: '#FFFFFF',
        fabBackgroundPressed: 'rgb(240,240,240)',
        fabIcon: '#000000',
        fabShadow: '#000',
        
        // Input colors
        inputBackground: '#F5F5F5',
        inputText: '#000000',
        inputPlaceholder: '#999999',
        
        // Selection/Radio button colors
        selectionActive: '#007AFF',
        selectionInactive: '#C0C0C0',
        selectionDot: '#007AFF',
        
        // Overlay colors
        overlayBackground: '#FFFFFF',
        overlayBorder: 'rgba(0, 0, 0, 0.1)',
        overlayDivider: '#F0F0F0',
        overlayPressed: 'rgba(0, 0, 0, 0.05)',
        overlayLabel: '#666666',
        
        // Permission mode colors
        permissionDefault: '#8E8E93',
        permissionAcceptEdits: '#007AFF',
        permissionBypass: '#FF9500',
        permissionPlan: '#34C759',
        
        // Button/Icon colors
        buttonIconDefault: '#000000',
        buttonIconSecondary: '#666666',
        sendButtonBackground: '#000000',
        sendButtonBackgroundDisabled: '#E0E0E0',
        sendButtonIcon: '#FFFFFF',
        abortIndicatorColor: Platform.select({ ios: '#FF9500', android: '#FF6F00', default: '#FF9500' }),
        
        // Context warning colors
        contextWarningCritical: '#FF3B30',
        contextWarningNormal: '#8E8E93'
    },
};

export const darkTheme = {
    dark: true,
    colors: {
        background: '#18171C',
        primary: '#ffffff',
        
        // Item colors
        titleText: '#FFFFFF',
        titleSelected: Platform.select({ ios: '#0A84FF', default: '#90CAF9' }),
        titleDestructive: Platform.select({ ios: '#FF453A', default: '#F48FB1' }),
        subtitleText: Platform.select({ ios: '#8E8E93', default: '#CAC4D0' }),
        detailText: Platform.select({ ios: '#8E8E93', default: '#CAC4D0' }),
        chevron: Platform.select({ ios: '#48484A', default: '#CAC4D0' }),
        divider: Platform.select({ ios: '#38383A', default: '#49454F' }),
        pressedOverlay: Platform.select({ ios: '#2C2C2E', default: 'transparent' }),
        ripple: 'rgba(255, 255, 255, 0.08)',
        
        // List colors
        listBackground: Platform.select({ ios: '#000000', default: '#121212' }),
        cardBackground: Platform.select({ ios: '#1C1C1E', default: '#1e1e1e' }),
        headerText: Platform.select({ ios: '#8E8E93', default: '#CAC4D0' }),
        shadowColor: '#000',
        
        // Header dark colors
        headerBackground: Platform.select({ ios: '#1C1C1E', default: '#1e1e1e' }),
        headerTint: '#FFFFFF',
        headerBorder: 'rgba(255,255,255,0.05)',
        
        // Status colors (same as light for now)
        statusConnected: '#34C759',
        statusConnecting: '#0A84FF',
        statusDisconnected: '#8E8E93',
        statusError: '#FF453A',
        statusDefault: '#8E8E93',
        
        // Switch colors - neutral for dark mode
        switchTrackActive: Platform.select({ ios: '#8E8E93', default: '#6C6C6C' }),
        switchTrackInactive: '#48484A',
        switchThumb: '#FFFFFF',
        
        // FAB colors
        fabBackground: Platform.select({ ios: '#1C1C1E', default: '#1e1e1e' }),
        fabBackgroundPressed: Platform.select({ ios: '#2C2C2E', default: '#2e2e2e' }),
        fabIcon: '#FFFFFF',
        fabShadow: '#000',
        
        // Input colors
        inputBackground: Platform.select({ ios: '#1C1C1E', default: '#1e1e1e' }),
        inputText: '#FFFFFF',
        inputPlaceholder: '#8E8E93',
        
        // Selection/Radio button colors
        selectionActive: '#0A84FF',
        selectionInactive: '#48484A',
        selectionDot: '#0A84FF',
        
        // Overlay colors
        overlayBackground: Platform.select({ ios: '#1C1C1E', default: '#1e1e1e' }),
        overlayBorder: 'rgba(255, 255, 255, 0.1)',
        overlayDivider: '#38383A',
        overlayPressed: 'rgba(255, 255, 255, 0.08)',
        overlayLabel: '#8E8E93',
        
        // Permission mode colors
        permissionDefault: '#8E8E93',
        permissionAcceptEdits: '#0A84FF',
        permissionBypass: '#FF9F0A',
        permissionPlan: '#32D74B',
        
        // Button/Icon colors
        buttonIconDefault: '#FFFFFF',
        buttonIconSecondary: '#8E8E93',
        sendButtonBackground: '#FFFFFF',
        sendButtonBackgroundDisabled: '#48484A',
        sendButtonIcon: '#000000',
        abortIndicatorColor: Platform.select({ ios: '#FF9F0A', android: '#FFB74D', default: '#FF9F0A' }),
        
        // Context warning colors
        contextWarningCritical: '#FF453A',
        contextWarningNormal: '#8E8E93'
    },
} satisfies typeof lightTheme;


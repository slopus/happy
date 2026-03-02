import { Platform } from 'react-native';

// Shared spacing, sizing constants (DRY - used by both themes)
const sharedSpacing = {
    // Spacing scale (based on actual usage patterns in codebase)
    margins: {
        xs: 4,   // Tight spacing, status indicators
        sm: 8,   // Small gaps, most common gap value
        md: 12,  // Button gaps, card margins
        lg: 16,  // Most common padding value
        xl: 20,  // Large padding
        xxl: 24, // Section spacing
    },

    // Border radii (based on actual usage patterns in codebase)
    borderRadius: {
        sm: 4,   // Checkboxes (20x20 boxes use 4px corners)
        md: 8,   // Buttons, items (most common - 31 uses)
        lg: 10,  // Input fields (matches "new session panel input fields")
        xl: 12,  // Cards, containers (20 uses)
        xxl: 16, // Main containers
    },

    // Icon sizes (based on actual usage patterns)
    iconSize: {
        small: 12,  // Inline icons (checkmark, lock, status indicators)
        medium: 16, // Section headers, add buttons
        large: 20,  // Action buttons (delete, duplicate, edit) - most common
        xlarge: 24, // Main section icons (desktop, folder)
    },
} as const;

export const lightTheme = {
    dark: false,
    colors: {

        //
        // Main colors
        //

        text: '#000000',
        textDestructive: Platform.select({ ios: '#FF3B30', default: '#F44336' }),
        textSecondary: Platform.select({ ios: '#8E8E93', default: '#49454F' }),
        textLink: '#2BACCC',
        deleteAction: '#FF6B6B', // Delete/remove button color
        warningCritical: '#FF3B30',
        warning: '#8E8E93',
        success: '#34C759',
        surface: '#ffffff',
        surfaceRipple: 'rgba(0, 0, 0, 0.08)',
        surfacePressed: '#f0f0f2',
        surfaceSelected: Platform.select({ ios: '#C6C6C8', default: '#eaeaea' }),
        surfacePressedOverlay: Platform.select({ ios: '#D1D1D6', default: 'transparent' }),
        surfaceHigh: '#F8F8F8',
        surfaceHighest: '#f0f0f0',
        divider: Platform.select({ ios: '#eaeaea', default: '#eaeaea' }),
        shadow: {
            color: Platform.select({ default: '#000000', web: 'rgba(0, 0, 0, 0.1)' }),
            opacity: 0.1,
        },

        //
        // System components
        //

        groupped: {
            background: Platform.select({ ios: '#F2F2F7', default: '#F5F5F5' }),
            chevron: Platform.select({ ios: '#C7C7CC', default: '#49454F' }),
            sectionTitle: Platform.select({ ios: '#8E8E93', default: '#49454F' }),
        },
        header: {
            background: '#ffffff',
            tint: '#18171C'
        },
        switch: {
            track: {
                active: Platform.select({ ios: '#34C759', default: '#1976D2' }),
                inactive: '#dddddd',
            },
            thumb: {
                active: '#FFFFFF',
                inactive: '#767577',
            },
        },
        fab: {
            background: '#000000',
            backgroundPressed: '#1a1a1a',
            icon: '#FFFFFF',
        },
        radio: {
            active: '#007AFF',
            inactive: '#C0C0C0',
            dot: '#007AFF',
        },
        modal: {
            border: 'rgba(0, 0, 0, 0.1)'
        },
        button: {
            primary: {
                background: '#000000',
                tint: '#FFFFFF',
                disabled: '#C0C0C0',
            },
            secondary: {
                tint: '#666666',
            }
        },
        input: {
            background: '#F5F5F5',
            text: '#000000',
            placeholder: '#999999',
        },
        box: {
            warning: {
                background: '#FFF8F0',
                border: '#FF9500',
                text: '#FF9500',
            },
            error: {
                background: '#FFF0F0',
                border: '#FF3B30',
                text: '#FF3B30',
            }
        },

        //
        // App components
        //

        status: {
            connected: '#34C759',
            connecting: '#007AFF',
            disconnected: '#999999',
            error: '#FF3B30',
            default: '#8E8E93',
        },

        // Permission mode colors
        permission: {
            default: '#8E8E93',
            acceptEdits: '#007AFF',
            bypass: '#FF9500',
            plan: '#34C759',
            readOnly: '#8B8B8D',
            safeYolo: '#FF6B35',
            yolo: '#DC143C',
            zen: '#8B5CF6',
        },

        // Permission button colors
        permissionButton: {
            allow: {
                background: '#34C759',
                text: '#FFFFFF',
            },
            deny: {
                background: '#FF3B30',
                text: '#FFFFFF',
            },
            allowAll: {
                background: '#007AFF',
                text: '#FFFFFF',
            },
            inactive: {
                background: '#E5E5EA',
                border: '#D1D1D6',
                text: '#8E8E93',
            },
            selected: {
                background: '#F2F2F7',
                border: '#D1D1D6',
                text: '#3C3C43',
            },
        },


        // Diff view
        diff: {
            outline: '#E0E0E0',
            success: '#28A745',
            error: '#DC3545',
            // Traditional diff colors
            addedBg: '#E6FFED',
            addedBorder: '#34D058',
            addedText: '#24292E',
            removedBg: '#FFEEF0',
            removedBorder: '#D73A49',
            removedText: '#24292E',
            contextBg: '#F6F8FA',
            contextText: '#586069',
            lineNumberBg: '#F6F8FA',
            lineNumberText: '#959DA5',
            hunkHeaderBg: '#F1F8FF',
            hunkHeaderText: '#005CC5',
            leadingSpaceDot: '#E8E8E8',
            inlineAddedBg: '#ACFFA6',
            inlineAddedText: '#0A3F0A',
            inlineRemovedBg: '#FFCECB',
            inlineRemovedText: '#5A0A05',
        },

        // Message View colors
        userMessageBackground: '#f0eee6',
        userMessageText: '#000000',
        agentMessageText: '#000000',
        agentEventText: '#666666',

        // Code/Syntax colors
        syntaxKeyword: '#1d4ed8',
        syntaxString: '#059669',
        syntaxComment: '#6b7280',
        syntaxNumber: '#0891b2',
        syntaxFunction: '#9333ea',
        syntaxBracket1: '#ff6b6b',
        syntaxBracket2: '#4ecdc4',
        syntaxBracket3: '#45b7d1',
        syntaxBracket4: '#f7b731',
        syntaxBracket5: '#5f27cd',
        syntaxDefault: '#374151',

        // Git status colors
        gitBranchText: '#6b7280',
        gitFileCountText: '#6b7280',
        gitAddedText: '#22c55e',
        gitRemovedText: '#ef4444',

        // Terminal/Command colors
        terminal: {
            background: '#1E1E1E',
            prompt: '#34C759',
            command: '#E0E0E0',
            stdout: '#E0E0E0',
            stderr: '#FFB86C',
            error: '#FF5555',
            emptyOutput: '#6272A4',
        },

    },

    ...sharedSpacing,
};

export const darkTheme = {
    dark: true,
    colors: {

        //
        // Main colors
        //

        text: '#ffffff',
        textDestructive: Platform.select({ ios: '#FF453A', default: '#F48FB1' }),
        textSecondary: Platform.select({ ios: '#8E8E93', default: '#CAC4D0' }),
        textLink: '#2BACCC',
        deleteAction: '#FF6B6B', // Delete/remove button color (same in both themes)
        warningCritical: '#FF453A',
        warning: '#8E8E93',
        success: '#32D74B',
        surface: Platform.select({ ios: '#18171C', default: '#212121' }),
        surfaceRipple: 'rgba(255, 255, 255, 0.08)',
        surfacePressed: '#2C2C2E',
        surfaceSelected: '#2C2C2E',
        surfacePressedOverlay: Platform.select({ ios: '#2C2C2E', default: 'transparent' }),
        // iOS dark theme is #1c1c1e for items, and #000 for the background
        surfaceHigh: Platform.select({ ios: '#2C2C2E', default: '#171717' }),
        surfaceHighest: Platform.select({ ios: '#38383A', default: '#292929' }),
        divider: Platform.select({ ios: '#38383A', default: '#292929' }),
        shadow: {
            color: Platform.select({ default: '#000000', web: 'rgba(0, 0, 0, 0.1)' }),
            opacity: 0.1,
        },

        //
        // System components
        //

        header: {
            background: Platform.select({ ios: '#18171C', default: '#212121' }),
            tint: '#ffffff'
        },
        switch: {
            track: {
                active: Platform.select({ ios: '#34C759', default: '#1976D2' }),
                inactive: '#3a393f',
            },
            thumb: {
                active: '#FFFFFF',
                inactive: '#767577',
            },
        },
        groupped: {
            background: Platform.select({ ios: '#1C1C1E', default: '#1e1e1e' }),
            chevron: Platform.select({ ios: '#48484A', default: '#CAC4D0' }),
            sectionTitle: Platform.select({ ios: '#8E8E93', default: '#CAC4D0' }),
        },
        fab: {
            background: '#FFFFFF',
            backgroundPressed: '#f0f0f0',
            icon: '#000000',
        },
        radio: {
            active: '#0A84FF',
            inactive: '#48484A',
            dot: '#0A84FF',
        },
        modal: {
            border: 'rgba(255, 255, 255, 0.1)'
        },
        button: {
            primary: {
                background: '#000000',
                tint: '#FFFFFF',
                disabled: '#C0C0C0',
            },
            secondary: {
                tint: '#8E8E93',
            }
        },
        input: {
            background: Platform.select({ ios: '#1C1C1E', default: '#303030' }),
            text: '#FFFFFF',
            placeholder: '#8E8E93',
        },
        box: {
            warning: {
                background: 'rgba(255, 159, 10, 0.15)',
                border: '#FF9F0A',
                text: '#FFAB00',
            },
            error: {
                background: 'rgba(255, 69, 58, 0.15)',
                border: '#FF453A',
                text: '#FF6B6B',
            }
        },

        //
        // App components
        //

        status: { // App Connection Status
            connected: '#34C759',
            connecting: '#FFFFFF',
            disconnected: '#8E8E93',
            error: '#FF453A',
            default: '#8E8E93',
        },

        // Permission mode colors
        permission: {
            default: '#8E8E93',
            acceptEdits: '#0A84FF',
            bypass: '#FF9F0A',
            plan: '#32D74B',
            readOnly: '#98989D',
            safeYolo: '#FF7A4C',
            yolo: '#FF453A',
            zen: '#A78BFA',
        },

        // Permission button colors
        permissionButton: {
            allow: {
                background: '#32D74B',
                text: '#FFFFFF',
            },
            deny: {
                background: '#FF453A',
                text: '#FFFFFF',
            },
            allowAll: {
                background: '#0A84FF',
                text: '#FFFFFF',
            },
            inactive: {
                background: '#2C2C2E',
                border: '#38383A',
                text: '#8E8E93',
            },
            selected: {
                background: '#1C1C1E',
                border: '#38383A',
                text: '#FFFFFF',
            },
        },


        // Diff view
        diff: {
            outline: '#30363D',
            success: '#3FB950',
            error: '#F85149',
            // Traditional diff colors for dark mode
            addedBg: '#0D2E1F',
            addedBorder: '#3FB950',
            addedText: '#C9D1D9',
            removedBg: '#3F1B23',
            removedBorder: '#F85149',
            removedText: '#C9D1D9',
            contextBg: '#161B22',
            contextText: '#8B949E',
            lineNumberBg: '#161B22',
            lineNumberText: '#6E7681',
            hunkHeaderBg: '#161B22',
            hunkHeaderText: '#58A6FF',
            leadingSpaceDot: '#2A2A2A',
            inlineAddedBg: '#2A5A2A',
            inlineAddedText: '#7AFF7A',
            inlineRemovedBg: '#5A2A2A',
            inlineRemovedText: '#FF7A7A',
        },

        // Message View colors
        userMessageBackground: '#2C2C2E',
        userMessageText: '#FFFFFF',
        agentMessageText: '#FFFFFF',
        agentEventText: '#8E8E93',

        // Code/Syntax colors (brighter for dark mode)
        syntaxKeyword: '#569CD6',
        syntaxString: '#CE9178',
        syntaxComment: '#6A9955',
        syntaxNumber: '#B5CEA8',
        syntaxFunction: '#DCDCAA',
        syntaxBracket1: '#FFD700',
        syntaxBracket2: '#DA70D6',
        syntaxBracket3: '#179FFF',
        syntaxBracket4: '#FF8C00',
        syntaxBracket5: '#00FF00',
        syntaxDefault: '#D4D4D4',

        // Git status colors
        gitBranchText: '#8E8E93',
        gitFileCountText: '#8E8E93',
        gitAddedText: '#34C759',
        gitRemovedText: '#FF453A',

        // Terminal/Command colors
        terminal: {
            background: '#1E1E1E',
            prompt: '#32D74B',
            command: '#E0E0E0',
            stdout: '#E0E0E0',
            stderr: '#FFB86C',
            error: '#FF6B6B',
            emptyOutput: '#7B7B93',
        },

    },

    ...sharedSpacing,
} satisfies typeof lightTheme;

// Helper to create dark theme variants by deep-merging color overrides
function createDarkVariant(overrides: Record<string, any>): typeof darkTheme {
    const base = JSON.parse(JSON.stringify(darkTheme));
    function deepMerge(target: any, source: any) {
        for (const key of Object.keys(source)) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object') {
                deepMerge(target[key], source[key]);
            } else {
                target[key] = source[key];
            }
        }
        return target;
    }
    deepMerge(base.colors, overrides);
    return base;
}

// Carbon — clean grays, high contrast, mint accent. Inspired by Linear/Vercel.
export const darkCarbonTheme = createDarkVariant({
    text: '#F0F0F0',
    textSecondary: '#A0A0A0',
    textLink: '#5DE4C7',
    surface: '#171717',
    surfacePressed: '#262626',
    surfaceSelected: '#262626',
    surfaceHigh: '#141414',
    surfaceHighest: '#2A2A2A',
    divider: '#2A2A2A',
    header: { background: '#171717', tint: '#F0F0F0' },
    groupped: { background: '#141414', chevron: '#A0A0A0', sectionTitle: '#A0A0A0' },
    input: { background: '#262626', text: '#F0F0F0', placeholder: '#666666' },
    userMessageBackground: '#262626',
    agentEventText: '#777777',
    status: { connected: '#5DE4C7', connecting: '#F0F0F0', disconnected: '#666666', error: '#FF6B6B', default: '#666666' },
    switch: { track: { active: '#5DE4C7', inactive: '#333333' }, thumb: { active: '#FFFFFF', inactive: '#767577' } },
    radio: { active: '#5DE4C7', inactive: '#404040', dot: '#5DE4C7' },
    fab: { background: '#5DE4C7', backgroundPressed: '#4CCFB3', icon: '#000000' },
    terminal: { background: '#141414', prompt: '#5DE4C7', command: '#E0E0E0', stdout: '#E0E0E0', stderr: '#FFB86C', error: '#FF6B6B', emptyOutput: '#555555' },
    diff: { outline: '#2A2A2A', contextBg: '#141414', lineNumberBg: '#141414', hunkHeaderBg: '#141414', hunkHeaderText: '#5DE4C7', leadingSpaceDot: '#252525' },
    permission: { default: '#666666', acceptEdits: '#5DE4C7', bypass: '#FFB86C', plan: '#5DE4C7', readOnly: '#777777', safeYolo: '#FF7A4C', yolo: '#FF453A', zen: '#A78BFA' },
    permissionButton: { allow: { background: '#5DE4C7', text: '#000000' }, deny: { background: '#FF453A', text: '#FFFFFF' }, allowAll: { background: '#5DE4C7', text: '#000000' }, inactive: { background: '#262626', border: '#333333', text: '#666666' }, selected: { background: '#1A1A1A', border: '#333333', text: '#F0F0F0' } },
}) satisfies typeof lightTheme;

// Warm Night — warm amber tones, cozy feel. Inspired by Notion dark, Craft.
export const darkWarmTheme = createDarkVariant({
    text: '#F5E6D3',
    textSecondary: '#A89585',
    textLink: '#E8A96B',
    surface: '#1A1410',
    surfacePressed: '#2A2219',
    surfaceSelected: '#2A2219',
    surfaceHigh: '#151008',
    surfaceHighest: '#302820',
    divider: '#302820',
    header: { background: '#1A1410', tint: '#F5E6D3' },
    groupped: { background: '#151008', chevron: '#A89585', sectionTitle: '#A89585' },
    input: { background: '#2A2219', text: '#F5E6D3', placeholder: '#736355' },
    userMessageBackground: '#2A2219',
    agentEventText: '#8B7B6B',
    status: { connected: '#D4A574', connecting: '#F5E6D3', disconnected: '#736355', error: '#E87461', default: '#736355' },
    switch: { track: { active: '#D4A574', inactive: '#3A3028' }, thumb: { active: '#FFFFFF', inactive: '#767577' } },
    radio: { active: '#E8A96B', inactive: '#3A3028', dot: '#E8A96B' },
    fab: { background: '#E8A96B', backgroundPressed: '#D49A5C', icon: '#1A1410' },
    terminal: { background: '#151008', prompt: '#D4A574', command: '#E8D5C0', stdout: '#E8D5C0', stderr: '#E8A96B', error: '#E87461', emptyOutput: '#5A4A3A' },
    diff: { outline: '#302820', contextBg: '#151008', lineNumberBg: '#151008', hunkHeaderBg: '#151008', hunkHeaderText: '#E8A96B', leadingSpaceDot: '#252015' },
    permission: { default: '#736355', acceptEdits: '#E8A96B', bypass: '#E8A96B', plan: '#D4A574', readOnly: '#8B7B6B', safeYolo: '#E87461', yolo: '#E05040', zen: '#C4A0E8' },
    permissionButton: { allow: { background: '#D4A574', text: '#1A1410' }, deny: { background: '#E87461', text: '#FFFFFF' }, allowAll: { background: '#E8A96B', text: '#1A1410' }, inactive: { background: '#2A2219', border: '#3A3028', text: '#736355' }, selected: { background: '#201810', border: '#3A3028', text: '#F5E6D3' } },
    syntaxKeyword: '#E8A96B',
    syntaxString: '#D4A574',
    syntaxComment: '#736355',
    syntaxNumber: '#C4A0E8',
    syntaxFunction: '#F0C090',
    syntaxDefault: '#E8D5C0',
}) satisfies typeof lightTheme;

// Deep Ocean — dark navy, blue accents. Inspired by GitHub Dark, Arc browser.
export const darkOceanTheme = createDarkVariant({
    text: '#E6EDF3',
    textSecondary: '#8B949E',
    textLink: '#58A6FF',
    surface: '#0D1117',
    surfacePressed: '#1B2332',
    surfaceSelected: '#1B2332',
    surfaceHigh: '#090D13',
    surfaceHighest: '#21262D',
    divider: '#21262D',
    header: { background: '#0D1117', tint: '#E6EDF3' },
    groupped: { background: '#090D13', chevron: '#8B949E', sectionTitle: '#8B949E' },
    input: { background: '#161B22', text: '#E6EDF3', placeholder: '#6E7681' },
    userMessageBackground: '#161B22',
    agentEventText: '#6E7681',
    status: { connected: '#3FB950', connecting: '#E6EDF3', disconnected: '#6E7681', error: '#F85149', default: '#6E7681' },
    switch: { track: { active: '#58A6FF', inactive: '#21262D' }, thumb: { active: '#FFFFFF', inactive: '#767577' } },
    radio: { active: '#58A6FF', inactive: '#30363D', dot: '#58A6FF' },
    fab: { background: '#58A6FF', backgroundPressed: '#4090E8', icon: '#FFFFFF' },
    terminal: { background: '#090D13', prompt: '#3FB950', command: '#C9D1D9', stdout: '#C9D1D9', stderr: '#D29922', error: '#F85149', emptyOutput: '#484F58' },
    diff: { outline: '#30363D', success: '#3FB950', error: '#F85149', addedBg: '#0D2E1F', addedBorder: '#3FB950', addedText: '#C9D1D9', removedBg: '#3F1B23', removedBorder: '#F85149', removedText: '#C9D1D9', contextBg: '#090D13', contextText: '#8B949E', lineNumberBg: '#090D13', lineNumberText: '#6E7681', hunkHeaderBg: '#0D1117', hunkHeaderText: '#58A6FF', leadingSpaceDot: '#1A1F26', inlineAddedBg: '#1A4A2A', inlineAddedText: '#7AFF7A', inlineRemovedBg: '#4A1A2A', inlineRemovedText: '#FF7A7A' },
    permission: { default: '#6E7681', acceptEdits: '#58A6FF', bypass: '#D29922', plan: '#3FB950', readOnly: '#8B949E', safeYolo: '#DB6D28', yolo: '#F85149', zen: '#A78BFA' },
    permissionButton: { allow: { background: '#3FB950', text: '#FFFFFF' }, deny: { background: '#F85149', text: '#FFFFFF' }, allowAll: { background: '#58A6FF', text: '#FFFFFF' }, inactive: { background: '#161B22', border: '#30363D', text: '#6E7681' }, selected: { background: '#0D1117', border: '#30363D', text: '#E6EDF3' } },
    syntaxKeyword: '#FF7B72',
    syntaxString: '#A5D6FF',
    syntaxComment: '#8B949E',
    syntaxNumber: '#79C0FF',
    syntaxFunction: '#D2A8FF',
    syntaxDefault: '#C9D1D9',
}) satisfies typeof lightTheme;

// OLED Black — true black for OLED screens, neon green accent. Maximum contrast.
export const darkOledTheme = createDarkVariant({
    text: '#FFFFFF',
    textSecondary: '#999999',
    textLink: '#00FF88',
    surface: '#000000',
    surfacePressed: '#1A1A1A',
    surfaceSelected: '#1A1A1A',
    surfaceHigh: '#000000',
    surfaceHighest: '#1F1F1F',
    divider: '#1F1F1F',
    header: { background: '#000000', tint: '#FFFFFF' },
    groupped: { background: '#000000', chevron: '#999999', sectionTitle: '#999999' },
    input: { background: '#1A1A1A', text: '#FFFFFF', placeholder: '#666666' },
    userMessageBackground: '#1A1A1A',
    agentEventText: '#777777',
    status: { connected: '#00FF88', connecting: '#FFFFFF', disconnected: '#666666', error: '#FF4444', default: '#666666' },
    switch: { track: { active: '#00FF88', inactive: '#2A2A2A' }, thumb: { active: '#FFFFFF', inactive: '#767577' } },
    radio: { active: '#00FF88', inactive: '#333333', dot: '#00FF88' },
    fab: { background: '#00FF88', backgroundPressed: '#00DD77', icon: '#000000' },
    button: { primary: { background: '#00FF88', tint: '#000000', disabled: '#555555' }, secondary: { tint: '#999999' } },
    terminal: { background: '#000000', prompt: '#00FF88', command: '#FFFFFF', stdout: '#FFFFFF', stderr: '#FFAA00', error: '#FF4444', emptyOutput: '#444444' },
    diff: { outline: '#1F1F1F', contextBg: '#000000', lineNumberBg: '#000000', hunkHeaderBg: '#000000', hunkHeaderText: '#00FF88', leadingSpaceDot: '#181818' },
    permission: { default: '#666666', acceptEdits: '#00FF88', bypass: '#FFAA00', plan: '#00FF88', readOnly: '#888888', safeYolo: '#FF7744', yolo: '#FF4444', zen: '#BB88FF' },
    permissionButton: { allow: { background: '#00FF88', text: '#000000' }, deny: { background: '#FF4444', text: '#FFFFFF' }, allowAll: { background: '#00FF88', text: '#000000' }, inactive: { background: '#1A1A1A', border: '#2A2A2A', text: '#666666' }, selected: { background: '#0A0A0A', border: '#2A2A2A', text: '#FFFFFF' } },
    syntaxKeyword: '#FF6688',
    syntaxString: '#00FF88',
    syntaxComment: '#555555',
    syntaxNumber: '#FFAA00',
    syntaxFunction: '#BB88FF',
    syntaxDefault: '#DDDDDD',
}) satisfies typeof lightTheme;

export type Theme = typeof lightTheme;

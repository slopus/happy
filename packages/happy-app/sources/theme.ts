import { Platform } from 'react-native';
import { palette as P } from './palette';

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
        // Palette — direct chromatic and neutral access
        //

        red:    { standard: P.red.standard,    soft: P.red.soft,    bg: P.red.bgLight },
        orange: { standard: P.orange.standard,  soft: P.orange.soft,  bg: P.orange.bgLight },
        yellow: { standard: P.yellow.standard,  soft: P.yellow.soft,  bg: P.yellow.bgLight },
        green:  { standard: P.green.standard,   soft: P.green.soft,   bg: P.green.bgLight },
        cyan:   { standard: P.cyan.standard,    soft: P.cyan.soft,    bg: P.cyan.bgLight },
        blue:   { standard: P.blue.standard,    soft: P.blue.soft,    bg: P.blue.bgLight },
        purple: { standard: P.purple.standard,  soft: P.purple.soft,  bg: P.purple.bgLight },
        pink:   { standard: P.pink.standard,    soft: P.pink.soft,    bg: P.pink.bgLight },
        neutral: P.neutral,

        //
        // Semantic tokens — main colors
        //

        text: P.neutral.black,
        textDestructive: P.red.standard,
        textSecondary: Platform.select({ ios: P.neutral.gray400, default: P.neutral.gray700 }),
        textLink: P.cyan.standard,
        deleteAction: P.red.soft,
        warningCritical: P.red.standard,
        warning: P.neutral.gray400,
        success: P.green.standard,
        surface: P.neutral.white,
        surfaceRipple: 'rgba(0, 0, 0, 0.08)',
        surfacePressed: P.neutral.gray50,
        surfaceSelected: Platform.select({ ios: P.neutral.gray200, default: P.neutral.gray100 }),
        surfacePressedOverlay: Platform.select({ ios: P.neutral.gray150 as string, default: 'transparent' }),
        surfaceHigh: P.neutral.gray75,
        surfaceHighest: P.neutral.gray50,
        divider: P.neutral.gray100,
        shadow: {
            color: Platform.select({ default: P.neutral.black, web: 'rgba(0, 0, 0, 0.1)' }),
            opacity: 0.1,
        },

        //
        // System components
        //

        groupped: {
            background: P.neutral.gray50,
            chevron: Platform.select({ ios: P.neutral.gray200, default: P.neutral.gray700 }),
            sectionTitle: Platform.select({ ios: P.neutral.gray400, default: P.neutral.gray700 }),
        },
        header: {
            background: P.neutral.white,
            tint: P.neutral.gray950,
        },
        switch: {
            track: {
                active: Platform.select({ ios: P.green.standard, default: P.blue.standard }),
                inactive: P.neutral.gray150,
            },
            thumb: {
                active: P.neutral.white,
                inactive: P.neutral.gray500,
            },
        },
        fab: {
            background: P.neutral.black,
            backgroundPressed: P.neutral.gray950,
            icon: P.neutral.white,
        },
        radio: {
            active: P.blue.standard,
            inactive: P.neutral.gray200,
            dot: P.blue.standard,
        },
        modal: {
            border: 'rgba(0, 0, 0, 0.1)',
        },
        button: {
            primary: {
                background: P.neutral.black,
                tint: P.neutral.white,
                disabled: P.neutral.gray200,
            },
            secondary: {
                tint: P.neutral.gray600,
            },
        },
        input: {
            background: P.neutral.gray50,
            text: P.neutral.black,
            placeholder: P.neutral.gray400,
        },
        box: {
            warning: {
                background: P.orange.bgLight,
                border: P.orange.standard,
                text: P.orange.standard,
            },
            error: {
                background: P.red.bgLight,
                border: P.red.standard,
                text: P.red.standard,
            },
        },

        //
        // App components
        //

        status: {
            connected: P.green.standard,
            connecting: P.blue.standard,
            disconnected: P.neutral.gray400,
            error: P.red.standard,
            default: P.neutral.gray400,
        },

        // Permission mode colors
        permission: {
            default: P.neutral.gray400,
            acceptEdits: P.blue.standard,
            bypass: P.orange.standard,
            plan: P.green.standard,
            readOnly: P.neutral.gray400,
            safeYolo: '#FF6B35', // intentional — between orange and red
            yolo: '#DC143C',     // intentional — crimson, darker than error red
        },

        // Permission button colors
        permissionButton: {
            allow: {
                background: P.green.standard,
                text: P.neutral.white,
            },
            deny: {
                background: P.red.standard,
                text: P.neutral.white,
            },
            allowAll: {
                background: P.blue.standard,
                text: P.neutral.white,
            },
            inactive: {
                background: P.neutral.gray100,
                border: P.neutral.gray150,
                text: P.neutral.gray400,
            },
            selected: {
                background: P.neutral.gray50,
                border: P.neutral.gray150,
                text: P.neutral.gray800,
            },
        },

        // Diff view (GitHub-derived — specialized for code contrast)
        diff: {
            outline: P.neutral.gray150,
            success: P.green.standard,
            error: P.red.standard,
            addedBg: '#E6FFED',
            addedBorder: P.green.dark,
            addedText: '#24292E',
            removedBg: '#FFEEF0',
            removedBorder: '#D73A49',
            removedText: '#24292E',
            contextBg: P.neutral.gray50,
            contextText: P.neutral.gray500,
            lineNumberBg: P.neutral.gray50,
            lineNumberText: P.neutral.gray300,
            hunkHeaderBg: P.blue.bgLight,
            hunkHeaderText: P.blue.standard,
            leadingSpaceDot: P.neutral.gray100,
            inlineAddedBg: '#ACFFA6',
            inlineAddedText: '#0A3F0A',
            inlineRemovedBg: '#FFCECB',
            inlineRemovedText: '#5A0A05',
        },

        // Message View colors
        userMessageBackground: '#f0eee6', // warm beige — intentionally non-palette
        userMessageText: P.neutral.black,
        agentMessageText: P.neutral.black,
        agentEventText: P.neutral.gray600,

        // Code/Syntax colors (VS Code-derived — specialized for readability)
        syntaxKeyword: '#1d4ed8',
        syntaxString: '#059669',
        syntaxComment: P.neutral.gray500,
        syntaxNumber: '#0891b2',
        syntaxFunction: '#9333ea',
        syntaxBracket1: '#ff6b6b',
        syntaxBracket2: '#4ecdc4',
        syntaxBracket3: '#45b7d1',
        syntaxBracket4: '#f7b731',
        syntaxBracket5: '#5f27cd',
        syntaxDefault: P.neutral.gray800,

        // Git status colors
        gitBranchText: P.neutral.gray500,
        gitFileCountText: P.neutral.gray500,
        gitAddedText: P.green.standard,
        gitRemovedText: P.red.standard,

        // Terminal/Command colors
        terminal: {
            background: P.neutral.gray950,
            prompt: P.green.standard,
            command: P.neutral.gray150,
            stdout: P.neutral.gray150,
            stderr: P.orange.soft,
            error: P.red.dark,
            emptyOutput: P.neutral.gray500,
        },

    },

    ...sharedSpacing,
};

export const darkTheme = {
    dark: true,
    colors: {

        //
        // Palette — direct chromatic and neutral access
        //

        red:    { standard: P.red.dark,    soft: P.red.soft,    bg: P.red.bgDark },
        orange: { standard: P.orange.dark,  soft: P.orange.soft,  bg: P.orange.bgDark },
        yellow: { standard: P.yellow.dark,  soft: P.yellow.soft,  bg: P.yellow.bgDark },
        green:  { standard: P.green.dark,   soft: P.green.soft,   bg: P.green.bgDark },
        cyan:   { standard: P.cyan.dark,    soft: P.cyan.soft,    bg: P.cyan.bgDark },
        blue:   { standard: P.blue.dark,    soft: P.blue.soft,    bg: P.blue.bgDark },
        purple: { standard: P.purple.dark,  soft: P.purple.soft,  bg: P.purple.bgDark },
        pink:   { standard: P.pink.dark,    soft: P.pink.soft,    bg: P.pink.bgDark },
        neutral: P.neutral,

        //
        // Semantic tokens — main colors
        //

        text: P.neutral.white,
        textDestructive: Platform.select({ ios: P.red.dark as string, default: P.red.soft }),
        textSecondary: Platform.select({ ios: P.neutral.gray400, default: P.neutral.gray200 }),
        textLink: P.cyan.standard,
        deleteAction: P.red.soft,
        warningCritical: P.red.dark,
        warning: P.neutral.gray400,
        success: P.green.dark,
        surface: P.neutral.gray950,
        surfaceRipple: 'rgba(255, 255, 255, 0.08)',
        surfacePressed: P.neutral.gray900,
        surfaceSelected: P.neutral.gray900,
        surfacePressedOverlay: Platform.select({ ios: P.neutral.gray900 as string, default: 'transparent' }),
        surfaceHigh: P.neutral.gray900,
        surfaceHighest: P.neutral.gray800,
        divider: Platform.select({ ios: P.neutral.gray800, default: P.neutral.gray900 }),
        shadow: {
            color: Platform.select({ default: P.neutral.black, web: 'rgba(0, 0, 0, 0.1)' }),
            opacity: 0.1,
        },

        //
        // System components
        //

        header: {
            background: P.neutral.gray950,
            tint: P.neutral.white,
        },
        switch: {
            track: {
                active: Platform.select({ ios: P.green.standard, default: P.blue.standard }),
                inactive: P.neutral.gray800,
            },
            thumb: {
                active: P.neutral.white,
                inactive: P.neutral.gray500,
            },
        },
        groupped: {
            background: P.neutral.gray950,
            chevron: Platform.select({ ios: P.neutral.gray700, default: P.neutral.gray200 }),
            sectionTitle: Platform.select({ ios: P.neutral.gray400, default: P.neutral.gray200 }),
        },
        fab: {
            background: P.neutral.white,
            backgroundPressed: P.neutral.gray50,
            icon: P.neutral.black,
        },
        radio: {
            active: P.blue.dark,
            inactive: P.neutral.gray700,
            dot: P.blue.dark,
        },
        modal: {
            border: 'rgba(255, 255, 255, 0.1)',
        },
        button: {
            primary: {
                background: P.neutral.black,
                tint: P.neutral.white,
                disabled: P.neutral.gray200,
            },
            secondary: {
                tint: P.neutral.gray400,
            },
        },
        input: {
            background: Platform.select({ ios: P.neutral.gray950, default: P.neutral.gray900 }),
            text: P.neutral.white,
            placeholder: P.neutral.gray400,
        },
        box: {
            warning: {
                background: 'rgba(255, 159, 10, 0.15)',
                border: P.orange.dark,
                text: P.orange.soft,
            },
            error: {
                background: 'rgba(255, 69, 58, 0.15)',
                border: P.red.dark,
                text: P.red.soft,
            },
        },

        //
        // App components
        //

        status: {
            connected: P.green.standard,
            connecting: P.neutral.white,
            disconnected: P.neutral.gray400,
            error: P.red.dark,
            default: P.neutral.gray400,
        },

        // Permission mode colors
        permission: {
            default: P.neutral.gray400,
            acceptEdits: P.blue.dark,
            bypass: P.orange.dark,
            plan: P.green.dark,
            readOnly: P.neutral.gray400,
            safeYolo: '#FF7A4C', // intentional — between orange and red
            yolo: P.red.dark,
        },

        // Permission button colors
        permissionButton: {
            allow: {
                background: P.green.dark,
                text: P.neutral.white,
            },
            deny: {
                background: P.red.dark,
                text: P.neutral.white,
            },
            allowAll: {
                background: P.blue.dark,
                text: P.neutral.white,
            },
            inactive: {
                background: P.neutral.gray900,
                border: P.neutral.gray800,
                text: P.neutral.gray400,
            },
            selected: {
                background: P.neutral.gray950,
                border: P.neutral.gray800,
                text: P.neutral.white,
            },
        },

        // Diff view (GitHub dark — specialized for code contrast)
        diff: {
            outline: '#30363D',
            success: P.green.dark,
            error: P.red.dark,
            addedBg: '#0D2E1F',
            addedBorder: P.green.dark,
            addedText: '#C9D1D9',
            removedBg: '#3F1B23',
            removedBorder: P.red.dark,
            removedText: '#C9D1D9',
            contextBg: P.neutral.gray950,
            contextText: P.neutral.gray400,
            lineNumberBg: P.neutral.gray950,
            lineNumberText: P.neutral.gray600,
            hunkHeaderBg: P.neutral.gray950,
            hunkHeaderText: P.blue.soft,
            leadingSpaceDot: P.neutral.gray900,
            inlineAddedBg: '#2A5A2A',
            inlineAddedText: '#7AFF7A',
            inlineRemovedBg: '#5A2A2A',
            inlineRemovedText: '#FF7A7A',
        },

        // Message View colors
        userMessageBackground: P.neutral.gray900,
        userMessageText: P.neutral.white,
        agentMessageText: P.neutral.white,
        agentEventText: P.neutral.gray400,

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
        syntaxDefault: P.neutral.gray150,

        // Git status colors
        gitBranchText: P.neutral.gray400,
        gitFileCountText: P.neutral.gray400,
        gitAddedText: P.green.standard,
        gitRemovedText: P.red.dark,

        // Terminal/Command colors
        terminal: {
            background: P.neutral.gray950,
            prompt: P.green.dark,
            command: P.neutral.gray150,
            stdout: P.neutral.gray150,
            stderr: P.orange.soft,
            error: P.red.soft,
            emptyOutput: P.neutral.gray500,
        },

    },

    ...sharedSpacing,
} satisfies typeof lightTheme;

export type Theme = typeof lightTheme;

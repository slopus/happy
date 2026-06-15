const RIGHT_SIDEBAR_MIN_WINDOW_WIDTH = 1100;

type NewSessionSidebarLayoutInput = {
    platform: 'web' | 'ios' | 'android' | 'macos' | 'windows';
    isMac: boolean;
    fileDiffsSidebarEnabled: boolean;
    zenMode: boolean;
    windowWidth: number;
};

export function getNewSessionSidebarLayout(input: NewSessionSidebarLayoutInput) {
    const canShowSidebar = input.fileDiffsSidebarEnabled
        && (input.isMac || input.platform === 'web')
        && input.windowWidth >= RIGHT_SIDEBAR_MIN_WINDOW_WIDTH;
    const showSidebar = canShowSidebar && !input.zenMode;
    const sidebarWidth = Math.min(Math.max(Math.floor(input.windowWidth * 0.3), 250), 360);

    return { canShowSidebar, showSidebar, sidebarWidth };
}

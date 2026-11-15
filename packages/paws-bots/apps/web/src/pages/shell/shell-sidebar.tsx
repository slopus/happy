import { hostRoot } from "../../paws/runtime";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group, NavLink } from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import {
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  Sidebar,
} from "@rakazo/ui-web";
import { Search, SlidersHorizontal } from "lucide-react";
import type { ReactNode, UIEvent } from "react";
import { useState } from "react";
import { InviteDialog } from "../../components/InviteDialog";
import { PasskeyOffer } from "../../components/PasskeyOffer";
import { useUsageHint } from "../../components/PlanUsage";
import { SidebarFooter } from "../../components/SidebarFooter";
import { useBilling } from "../../components/SubscriptionGate";
import { formatBillingDate } from "../../lib/billing";
import type { BotsSidebarDensity } from "../../lib/bots-sidebar-density-pref";
import { switchOrganization, useOrganizations } from "../../lib/organizations";
import { useQueryUserId } from "../../lib/query";
import type { Panel } from "../../lib/right-panel-state";
import { useSignOut } from "../../lib/sign-out";
import { ActivityList } from "../ActivityList";
import { SpaceSearchResults } from "../SpaceSearch";
import type { SettingsSection } from "../shell-overlay";
import type { ChatMenuState } from "./chat-context-menu";
import { SidebarHeader } from "./sidebar-header";
import type { SidebarSearch } from "./use-sidebar-search";

/** Focuses the search box once it renders, its text selected so typing replaces it. */
export function focusSidebarSearch() {
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>('input[name="sidebar-search"]');
    input?.focus();
    input?.select();
  });
}

/**
 * Chromium keeps the top fade drawn when collapsing sections shrinks a scrolled list until it no
 * longer scrolls; replaying the fade's scroll-driven animations lets it settle at the top.
 */
function resetFadeWhenUnscrollable(event: UIEvent<HTMLDivElement>) {
  const list = event.currentTarget;
  if (list.scrollHeight > list.clientHeight) return;
  for (const animation of list.getAnimations()) {
    animation.cancel();
    animation.play();
  }
}

type User = { name?: string | null; email?: string; image?: string | null };

/** The bots sidebar: a drawer on phones, collapsible to icons elsewhere. */
export function ShellSidebar({
  isMobile,
  mobileOpen,
  setMobileOpen,
  density,
  collapsed,
  mini,
  setCollapsedPref,
  createMenuOpen,
  setCreateMenuOpen,
  search,
  bots,
  groups,
  collapsedSidebarSections,
  toggleSidebarSection,
  setPanel,
  navigate,
  setNewSpaceOpen,
  setCreateBotOpen,
  chatMenu,
  roster,
  archived,
  footerLogos,
  user,
  ticketBoardEnabled,
  navLinks,
  openSettings,
  openIntegrations,
  openSkills,
  openSpaceChat,
}: {
  isMobile: boolean;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
  density: BotsSidebarDensity;
  collapsed: boolean;
  mini: boolean;
  setCollapsedPref: (collapsed: boolean) => void;
  createMenuOpen: boolean;
  setCreateMenuOpen: (open: boolean) => void;
  search: SidebarSearch;
  bots: Bot[];
  groups: Group[];
  collapsedSidebarSections: ReadonlySet<string>;
  toggleSidebarSection: (key: string) => void;
  setPanel: (panel: Panel) => void;
  navigate: (path: string) => void;
  setNewSpaceOpen: (open: boolean) => void;
  setCreateBotOpen: (open: boolean) => void;
  chatMenu: ChatMenuState;
  roster: ReactNode;
  archived: ReactNode;
  footerLogos: Array<{ name: string; logo?: string | null }>;
  user: User | undefined;
  ticketBoardEnabled: boolean;
  navLinks: NavLink[];
  openSettings: (section: SettingsSection) => void;
  openIntegrations: () => void;
  openSkills: () => void;
  openSpaceChat: (spaceId: string, path: string) => void;
}) {
  const { t } = useLingui();
  const {
    query,
    setQuery,
    searchOpen,
    setSearchOpen,
    searchHits,
    searchLoading,
    searchError,
    retrySearch,
    showSpaceSearch,
    jumpToSearchHit,
    activityMode,
    toggleActivityMode,
    activityFilters,
    setActivityFilters,
    activityFiltersExpanded,
    setActivityFiltersExpanded,
    activityFiltersId,
    activityFilterCount,
  } = search;
  return (
    <>
      <button
        type="button"
        aria-label={t`Close navigation`}
        aria-hidden={mobileOpen ? undefined : true}
        inert={mobileOpen ? undefined : true}
        tabIndex={mobileOpen ? undefined : -1}
        onClick={() => setMobileOpen(false)}
        className={`absolute inset-y-0 end-0 start-[min(calc(100%-48px),316px)] z-30 bg-overlay transition-opacity duration-150 ease-out motion-reduce:transition-none md:hidden ${
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <Sidebar
        collapsible={isMobile ? "none" : "icon"}
        side={hostRoot().dir === "rtl" ? "right" : "left"}
        data-testid="bots-sidebar"
        data-space-switch="sidebar"
        inert={isMobile && !mobileOpen ? true : undefined}
        aria-hidden={isMobile && !mobileOpen ? true : undefined}
        data-bots-sidebar-density={density}
        data-collapsed={collapsed ? "true" : "false"}
        className={
          isMobile
            ? `absolute inset-y-0 start-0 z-40 flex w-[calc(100%-48px)] max-w-[316px] shrink-0 flex-col border-e border-sidebar-border bg-sidebar transition-transform duration-200 ease-out motion-reduce:transition-none ${mobileOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full"}`
            : "h-full overflow-hidden border-sidebar-border"
        }
      >
        <SidebarHeader
          mini={mini}
          createMenuOpen={createMenuOpen}
          setCreateMenuOpen={setCreateMenuOpen}
          activityMode={activityMode}
          toggleActivityMode={() => {
            if (mini) setCollapsedPref(false);
            toggleActivityMode();
          }}
          searchOpen={searchOpen && !mini}
          onSearch={() => {
            if (searchOpen && !mini) {
              if (activityMode) setActivityFilters({ ...activityFilters, query: "" });
              else setQuery("");
              setSearchOpen(false);
              return;
            }
            if (mini) setCollapsedPref(false);
            setSearchOpen(true);
            focusSidebarSearch();
          }}
          setBotsSidebarCollapsedPref={setCollapsedPref}
          bots={bots}
          setMobileSidebarOpen={setMobileOpen}
          setPanel={setPanel}
          navigate={navigate}
          setNewSpaceOpen={setNewSpaceOpen}
          setCreateBotOpen={setCreateBotOpen}
        />
        {mini ||
        !(
          searchOpen ||
          query ||
          (activityMode && (activityFilterCount > 0 || activityFiltersExpanded))
        ) ? null : (
          <InputGroup
            data-testid="sidebar-search"
            className="mx-2.5 mb-3 w-auto rounded-xl bg-card dark:bg-input border border-border text-muted-foreground focus-within:border-ring"
          >
            <InputGroupAddon>
              <Search size={16} strokeWidth={1.8} aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              value={activityMode ? activityFilters.query : query}
              onChange={(e) => {
                if (activityMode) setActivityFilters({ ...activityFilters, query: e.target.value });
                else setQuery(e.target.value);
              }}
              onKeyDown={(event) => {
                if (
                  event.key !== "Escape" ||
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229
                )
                  return;
                if (activityMode) setActivityFilters({ ...activityFilters, query: "" });
                else setQuery("");
                setSearchOpen(false);
              }}
              placeholder={activityMode ? t`Search runs` : t`Search`}
              aria-label={activityMode ? t`Search runs` : t`Search`}
              autoComplete="off"
              name="sidebar-search"
            />
            {activityMode ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-sm"
                  aria-label={t`Filters`}
                  aria-expanded={activityFiltersExpanded}
                  aria-controls={activityFiltersId}
                  onClick={() => setActivityFiltersExpanded((expanded) => !expanded)}
                  className="relative rounded-lg"
                >
                  <SlidersHorizontal size={16} aria-hidden="true" />
                  {activityFilterCount > 0 ? (
                    <span
                      data-testid="activity-filter-indicator"
                      aria-hidden="true"
                      className="absolute end-1 top-1 size-1.5 rounded-full bg-primary"
                    />
                  ) : null}
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
        )}
        <div
          onScroll={resetFadeWhenUnscrollable}
          className="rk-scroll scroll-fade-y scroll-fade-12 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2.5"
        >
          {showSpaceSearch && !mini ? (
            <SpaceSearchResults
              hits={searchHits}
              loading={searchLoading}
              error={searchError}
              onRetry={retrySearch}
              onSelect={(hit) => jumpToSearchHit(hit)}
              chatMenu={chatMenu}
            />
          ) : activityMode && !mini ? (
            <ActivityList
              bots={bots}
              groups={groups}
              toggledSections={collapsedSidebarSections}
              onToggleSection={toggleSidebarSection}
              onOpenBot={(bot) => {
                setMobileOpen(false);
                navigate(`/app/${bot.id}`);
              }}
              onOpenGroup={(group) => {
                setMobileOpen(false);
                navigate(`/app/g/${group.id}`);
              }}
              filters={activityFilters}
              onFiltersChange={setActivityFilters}
              filtersExpanded={activityFiltersExpanded}
              filtersId={activityFiltersId}
              onOpenRun={(run) => {
                setMobileOpen(false);
                if (run.groupId) navigate(`/app/g/${run.groupId}`);
                else navigate(`/app/${run.botId}`);
              }}
            />
          ) : (
            roster
          )}
        </div>
        {/* One height limit for every shelf, so open shelves never squeeze out the chat list. */}
        <div
          className={
            mini || activityMode
              ? "hidden"
              : "rk-scroll flex max-h-[40vh] shrink-0 flex-col overflow-y-auto px-2.5 pb-1"
          }
        >
          {archived}
        </div>
        <div className={mini ? "hidden" : "contents"}>
          <PasskeyOffer />
        </div>
        <ShellSidebarFooter
          mini={mini}
          logos={footerLogos}
          user={user}
          ticketBoardEnabled={ticketBoardEnabled}
          navLinks={navLinks}
          closeMobileSidebar={() => setMobileOpen(false)}
          navigate={navigate}
          openSettings={openSettings}
          openIntegrations={openIntegrations}
          openSkills={openSkills}
          openSpaceChat={openSpaceChat}
        />
      </Sidebar>
    </>
  );
}

function ShellSidebarFooter({
  mini,
  logos,
  user,
  ticketBoardEnabled,
  navLinks,
  closeMobileSidebar,
  navigate,
  openSettings,
  openIntegrations,
  openSkills,
  openSpaceChat,
}: {
  mini: boolean;
  logos: Array<{ name: string; logo?: string | null }>;
  user: User | undefined;
  ticketBoardEnabled: boolean;
  navLinks: NavLink[];
  closeMobileSidebar: () => void;
  navigate: (path: string) => void;
  openSettings: (section: SettingsSection) => void;
  openIntegrations: () => void;
  openSkills: () => void;
  openSpaceChat: (spaceId: string, path: string) => void;
}) {
  const { t, i18n } = useLingui();
  const userId = useQueryUserId();
  const { organizations, activeOrganizationId } = useOrganizations();
  const { status: billing, showPlans } = useBilling();
  const freeUntil =
    billing?.funding === "byok" &&
    billing.byokFreeUntil &&
    new Date(billing.byokFreeUntil) > new Date()
      ? billing.byokFreeUntil
      : null;
  const usage = useUsageHint();
  const [menuOpen, setMenuOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const referral = billing?.referral;
  const [logOutError, setLogOutError] = useState<string | null>(null);
  const { signingOut, logOut } = useSignOut("/sign-in", (message) => {
    // A failed sign-out reloads the page: reopen the menu so its error shows.
    setMenuOpen(true);
    setLogOutError(message);
  });
  const { label: userName, initial: initials } = accountDisplay(user ?? {}, t`You`);
  const day = freeUntil ? formatBillingDate(freeUntil, i18n.locale || "en") : "";
  return (
    <>
      {freeUntil && !mini ? (
        <div className="mx-2.5 flex items-center justify-between gap-2 ps-2.5 text-body text-muted-foreground">
          <span className="min-w-0 truncate">
            <Trans>Free plan ends {day}</Trans>
          </span>
          {billing?.canManage ? (
            <Button variant="outline" size="sm" onClick={showPlans}>
              <Trans>Upgrade</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
      <SidebarFooter
        mini={mini}
        logos={logos}
        name={userName}
        initials={initials}
        image={user?.image}
        email={user?.email}
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (!open) setLogOutError(null);
        }}
        onIntegrations={() => {
          setMenuOpen(false);
          openIntegrations();
        }}
        onSkills={() => {
          setMenuOpen(false);
          openSkills();
        }}
        onBoard={
          ticketBoardEnabled
            ? () => {
                setMenuOpen(false);
                closeMobileSidebar();
                navigate("/app/board");
              }
            : undefined
        }
        links={navLinks}
        onLink={(link) => {
          setMenuOpen(false);
          closeMobileSidebar();
          navigate(`/app/x/${link.id}`);
        }}
        onArtifacts={() => {
          setMenuOpen(false);
          closeMobileSidebar();
          navigate("/app/artifacts");
        }}
        onSettings={() => {
          setMenuOpen(false);
          openSettings("general");
        }}
        usage={usage}
        onUsage={() => {
          setMenuOpen(false);
          openSettings("usage");
        }}
        onInvite={
          referral
            ? () => {
                setMenuOpen(false);
                setInviteOpen(true);
              }
            : undefined
        }
        onLogOut={() => {
          setLogOutError(null);
          void logOut();
        }}
        signingOut={signingOut}
        logOutError={logOutError}
        organizations={organizations}
        activeOrganizationId={activeOrganizationId}
        onSwitchOrganization={(organization) => {
          setMenuOpen(false);
          if (organization.id !== activeOrganizationId)
            void switchOrganization(userId, organization, openSpaceChat);
        }}
      />
      {referral ? (
        <InviteDialog referral={referral} open={inviteOpen} onOpenChange={setInviteOpen} />
      ) : null}
    </>
  );
}

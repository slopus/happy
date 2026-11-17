import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Bot, ComputerReleaseReason, ComputerStatus, TaughtSkill } from "@rakazo/contracts";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { TeachCaptureOverlay } from "../../components/teach/TeachCaptureOverlay";
import { TeachComputerOverlayControl } from "../../components/teach/TeachComputerOverlay";
import { TeachRecordingChrome, TeachStopButton } from "../../components/teach/TeachRecordingChrome";
import {
  proxiedScreenCapability,
  screenFrames,
  screenIframeSandbox,
} from "../../lib/computer-screen";
import {
  DARWIN_WINDOW_CONTROLS_WIDTH_PX,
  desktopBridge,
  windowChromeKind,
} from "../../lib/desktop";
import { embedded } from "../../paws/runtime";
import { ComputerReleaseActions } from "./computer-release-actions";
import { computerLabel, DesktopKindEmptyState } from "./computer-view";

type ComputerOverlayProps = {
  bot: Bot;
  computer: ComputerStatus | null;
  computerViewport: { height: number; offsetTop: number } | null;
  recordingSkill: TaughtSkill | null;
  teachBusy: boolean;
  hasControl: boolean;
  changingControl?: boolean;
  composerRunning: boolean;
  sending: boolean;
  booting: boolean;
  sendError: string | null;
  embeddedScreenUrl: string | null;
  /** Changes to load the screen again in a new frame. */
  screenFrameKey?: string;
  heldScreen?: { url: string; key: string } | null;
  screenFrameRef: (frame: HTMLIFrameElement | null) => void;
  computerScreenError: ReactNode;
  computerBooting: ReactNode;
  onStopTeaching: () => void | Promise<void>;
  onStopRun: () => void;
  onRelease: (reason?: ComputerReleaseReason) => Promise<void>;
  onTakeControl: () => void;
  onStart: () => void;
  onRefreshTeaching: () => Promise<void>;
  onClose: () => void;
};

export function ComputerOverlay({
  bot,
  computer,
  computerViewport,
  recordingSkill,
  teachBusy,
  hasControl,
  changingControl = false,
  composerRunning,
  sending,
  booting,
  sendError,
  embeddedScreenUrl,
  screenFrameKey,
  heldScreen,
  screenFrameRef,
  computerScreenError,
  computerBooting,
  onStopTeaching,
  onStopRun,
  onRelease,
  onTakeControl,
  onStart,
  onRefreshTeaching,
  onClose,
}: ComputerOverlayProps) {
  // A granted lease is not yet an input-capable screen. Keep the transition visible
  // while the old view frame covers the new connection.
  const switchingControl =
    changingControl ||
    Boolean(
      hasControl &&
        (heldScreen ||
          proxiedScreenCapability(embeddedScreenUrl)?.policy === "view"),
    );
  return (
    <div className="fixed inset-0 z-30 bg-background">
      <div
        data-testid="computer-viewport"
        className="fixed inset-x-0 top-0 flex flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
        style={{
          height: embedded ? "100%" : computerViewport ? `${computerViewport.height}px` : "100dvh",
          top: embedded ? 0 : computerViewport ? `${computerViewport.offsetTop}px` : undefined,
        }}
      >
        <div
          data-testid="computer-chrome"
          className="app-no-drag flex items-center justify-between gap-4 border-b border-sidebar-border px-[18px] py-3.5"
          style={
            windowChromeKind(desktopBridge()) === "darwin"
              ? { paddingLeft: DARWIN_WINDOW_CONTROLS_WIDTH_PX + 18 }
              : undefined
          }
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <BotAvatar
              avatarSet={bot.avatarSet}
              color={bot.color}
              identity={bot.id}
              size={28}
              status={bot.status}
            />
            {recordingSkill ? (
              <TeachRecordingChrome
                recording={recordingSkill}
                botId={bot.id}
                busy={teachBusy}
                onStop={onStopTeaching}
                variant="overlay"
              />
            ) : (
              <span className="truncate text-body-lg font-medium text-foreground" dir="auto">
                {computerLabel(computer?.mode, bot.name)}
              </span>
            )}
            {!recordingSkill && hasControl && computer?.shared ? (
              <span
                data-testid="computer-shared-browser"
                className="min-w-0 truncate text-body-sm text-muted-foreground"
              >
                <Trans>Sites you sign in to stay signed in for everyone in this space</Trans>
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            {composerRunning ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={t`Stop`}
                data-testid="computer-overlay-stop"
                onClick={() => void onStopRun()}
                disabled={sending}
              >
                <Trans>Stop</Trans>
              </Button>
            ) : null}
            {recordingSkill ? (
              <TeachStopButton busy={teachBusy} onStop={onStopTeaching} />
            ) : switchingControl ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled
                aria-busy="true"
              >
                <Trans>Connecting…</Trans>
              </Button>
            ) : hasControl ? (
              <ComputerReleaseActions
                takeoverRequested={Boolean(computer?.takeoverRequested)}
                onRelease={onRelease}
              />
            ) : computer?.state === "running" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={booting}
                onClick={() => void onTakeControl()}
              >
                <Trans>Take control</Trans>
              </Button>
            ) : null}
            {!recordingSkill ? (
              <TeachComputerOverlayControl
                key={bot.id}
                botId={bot.id}
                computer={computer}
                busy={teachBusy}
                onRefresh={onRefreshTeaching}
              />
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={t`Close computer`}
              onClick={() => onClose()}
            >
              <X size={16} strokeWidth={1.8} />
            </Button>
          </div>
        </div>
        {sendError ? (
          <div
            role="alert"
            className="border-b border-destructive/40 bg-destructive/10 px-[18px] py-2 text-body-sm text-destructive"
          >
            {sendError}
          </div>
        ) : null}
        <div className="relative min-h-0 flex-1 bg-background">
          {computer?.kind === "desktop" ? (
            <DesktopKindEmptyState className="grid h-full place-items-center px-8 text-center text-body text-muted-foreground/80" />
          ) : computer?.state === "running" && embeddedScreenUrl && !computerScreenError ? (
            <>
              {screenFrames(screenFrameKey, embeddedScreenUrl, heldScreen).map((frame) => (
                <iframe
                  key={frame.key}
                  title={frame.held ? undefined : t`Bot screen`}
                  aria-hidden={frame.held || undefined}
                  tabIndex={frame.held ? -1 : undefined}
                  ref={frame.held ? undefined : screenFrameRef}
                  src={frame.url}
                  sandbox={screenIframeSandbox(frame.url)}
                  className={`h-full w-full border-0 bg-black${frame.held ? " absolute inset-0" : ""}`}
                  allow="clipboard-read; clipboard-write; fullscreen"
                  style={{
                    pointerEvents:
                      frame.held || recordingSkill || !hasControl || switchingControl
                        ? "none"
                        : "auto",
                  }}
                />
              ))}
              {bot ? (
                <TeachCaptureOverlay
                  botId={bot.id}
                  skill={recordingSkill}
                  enabled={Boolean(recordingSkill)}
                  screenWidth={computer?.screenWidth}
                  screenHeight={computer?.screenHeight}
                />
              ) : null}
            </>
          ) : (
            <div className="grid h-full place-items-center text-body text-muted-foreground/80">
              {computerScreenError ??
                computerBooting ??
                (computer?.state === "stopped" || computer?.state === "suspended" ? (
                  <div className="flex flex-col items-center gap-3">
                    <p>
                      {computer.state === "suspended"
                        ? t`Computer is asleep`
                        : t`Computer is stopped`}
                    </p>
                    <Button variant="outline" size="sm" onClick={onStart}>
                      <Trans>Start</Trans>
                    </Button>
                  </div>
                ) : (
                  computerLabel(computer?.mode, bot.name)
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

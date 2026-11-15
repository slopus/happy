import { parseBotAvatarValue } from "@rakazo/contracts";
import type { LogoAvatarActivity } from "@rakazo/core";
import {
  LOGO_AVATAR_BODY_Y,
  LOGO_AVATAR_EYES,
  LOGO_AVATAR_VIEWBOX,
  logoAvatarEyeInk,
  logoAvatarTraits,
} from "@rakazo/core";
import { botEyeColor, tokens } from "@rakazo/ui-tokens";
import type { CSSProperties } from "react";
import { memo, useId, useMemo } from "react";
import { useAvatarMotionVisibility } from "./hooks/use-avatar-motion-visibility.js";
import { useLogoAvatarLayers } from "./hooks/use-logo-avatar-layers.js";
import { cn } from "./lib/utils.js";
import { LogoAvatarBody } from "./logo-avatar-body.js";
import "./logo-avatar.css";

/** Generated vector logo renderer. BotAvatar owns set selection and custom images. */
const eyes = LOGO_AVATAR_EYES;

export const LogoAvatar = memo(function LogoAvatar({
  activity = "idle",
  size = 38,
  avatarValue,
  identity,
  label,
  motion = true,
  className,
}: {
  activity?: LogoAvatarActivity;
  size?: number;
  avatarValue?: string;
  identity?: string;
  label?: string;
  motion?: boolean;
  className?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const parsed = useMemo(
    () => (avatarValue ? parseBotAvatarValue(avatarValue) : null),
    [avatarValue],
  );
  const traits = useMemo(
    () =>
      logoAvatarTraits(
        identity || (parsed && "color" in parsed ? parsed.color : "default"),
        parsed && "color" in parsed ? parsed.color : undefined,
      ),
    [identity, parsed],
  );
  const canMove = motion && size >= 24;
  const { ref, visible, reducedMotion } = useAvatarMotionVisibility(canMove);
  const { layers, finish } = useLogoAvatarLayers(
    ref,
    activity,
    canMove && visible && !reducedMotion,
    canMove,
  );
  const eyeInk = logoAvatarEyeInk(traits.color, tokens);
  return (
    <svg
      ref={ref}
      viewBox={LOGO_AVATAR_VIEWBOX}
      width={size}
      height={size}
      className={cn("rakazo-logo-avatar shrink-0", className)}
      data-activity={activity}
      data-working={activity !== "idle" && activity !== "error"}
      data-vector-body="true"
      data-motion={canMove}
      data-small={size < 24}
      data-compact={size <= 38}
      data-paused={!visible}
      data-color={traits.color}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={
        {
          "--logo-task-stroke": Math.max(2.4, 100 / Math.max(1, size)),
          "--logo-eye-light": eyeInk === botEyeColor ? tokens.foreground : botEyeColor,
          "--logo-blink-name": `logo-avatar-blink-${traits.blinkVariant}`,
          "--logo-blink-duration": `${traits.blinkMs}ms`,
          "--logo-blink-delay": `${traits.blinkDelayMs}ms`,
          "--logo-side": traits.side,
        } as CSSProperties
      }
    >
      <defs>
        <clipPath id={`logo-plate-${id}`}>
          <rect width="100" height="100" rx="23" />
        </clipPath>
        <linearGradient id={`logo-eye-${id}`} x2="0.8" y2="1">
          <stop stopColor={eyeInk} stopOpacity="0.8" />
          <stop offset="0.35" stopColor={eyeInk} />
          <stop offset="1" stopColor={eyeInk} />
        </linearGradient>
      </defs>
      <g clipPath={`url(#logo-plate-${id})`}>
        <rect className="logo-avatar-plate" width="100" height="100" rx="23" />
        {layers.map((layer) => (
          <g
            key={layer.key}
            className="logo-avatar-layer"
            data-logo-layer={layer.key}
            data-activity={layer.activity}
            data-entering={layer.entering}
            data-outgoing={layer.outgoing}
            style={
              {
                "--logo-move-duration": `${traits.periods[layer.activity]}ms`,
                "--logo-move-delay": `${-Math.round(traits.periods[layer.activity] * traits.phase * 1000) / 1000}ms`,
                "--logo-exit-from": layer.opacity,
              } as CSSProperties
            }
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) finish(layer.key, event.animationName);
            }}
          >
            <g className="logo-avatar-body">
              <g transform={`translate(0 ${LOGO_AVATAR_BODY_Y})`}>
                <LogoAvatarBody
                  id={`${id}-${layer.key}`}
                  color={traits.color}
                  originalOrange={traits.originalOrange}
                />
                <g className="logo-avatar-gaze">
                  <g className="logo-avatar-scan">
                    {[eyes.leftCx, eyes.rightCx].map((x, index) => (
                      <g
                        className={`logo-avatar-eye-lid logo-avatar-eye-${index}`}
                        key={x}
                        style={{ transformOrigin: `${x}px ${eyes.cy}px` }}
                      >
                        <g
                          className="logo-avatar-eye"
                          style={{ transformOrigin: `${x}px ${eyes.cy}px` }}
                        >
                          <ellipse
                            cx={x}
                            cy={eyes.cy}
                            rx={eyes.width / 2}
                            ry={eyes.height / 2}
                            fill={`url(#logo-eye-${id})`}
                          />
                          <ellipse
                            className="logo-avatar-glint"
                            cx={x - 1.2}
                            cy={eyes.cy - 3.6}
                            rx="1.4"
                            ry="2.2"
                          />
                        </g>
                      </g>
                    ))}
                  </g>
                </g>
              </g>
              <LogoAvatarTask activity={layer.activity} id={`${id}-${layer.key}`} />
            </g>
          </g>
        ))}
      </g>
      <rect className="logo-avatar-outline" x="0.5" y="0.5" width="99" height="99" rx="22.5" />
    </svg>
  );
});

/** Small illustrative task cues; these do not claim live pointer/key telemetry. */
function LogoAvatarTask({ activity, id }: { activity: LogoAvatarActivity; id: string }) {
  if (activity === "reading")
    return (
      <g className="logo-avatar-task logo-avatar-book">
        <defs>
          <clipPath id={`book-pages-${id}`} clipPathUnits="userSpaceOnUse">
            <path
              className="logo-avatar-safe-area"
              d="M26 79Q37 75 47 80V91Q37 87 26 91ZM53 80Q63 75 74 79V91Q63 87 53 91Z"
              fill="white"
              stroke="none"
            />
          </clipPath>
        </defs>
        <path
          className="logo-avatar-task-surface"
          d="M22 76Q36 71 50 77Q64 71 78 76V96Q64 91 50 97Q36 91 22 96Z"
        />
        <path d="M50 77V97" />
        <g className="logo-avatar-task-ink" clipPath={`url(#book-pages-${id})`}>
          <path d="M28 84H43M57 84H72" opacity="0.8" />
          <path
            className="logo-avatar-page-cursor logo-avatar-action logo-avatar-task-detail"
            d="M27 81.5H36"
          />
        </g>
      </g>
    );
  if (activity === "writing")
    return (
      <g className="logo-avatar-task logo-avatar-keyboard">
        <defs>
          <clipPath id={`keyboard-bed-${id}`} clipPathUnits="userSpaceOnUse">
            <rect
              className="logo-avatar-safe-area"
              x="26"
              y="78"
              width="48"
              height="16"
              rx="1"
              fill="white"
              stroke="none"
            />
          </clipPath>
        </defs>
        <rect className="logo-avatar-task-surface" x="22" y="75" width="56" height="22" rx="3" />
        <g className="logo-avatar-task-ink" clipPath={`url(#keyboard-bed-${id})`}>
          <path className="logo-avatar-key-left logo-avatar-action" d="M29 82H35M40 82H46" />
          <path className="logo-avatar-key-right logo-avatar-action" d="M54 82H60M65 82H71" />
          <path d="M36 90H64" opacity="0.85" />
        </g>
      </g>
    );
  if (activity === "computer")
    return (
      <g className="logo-avatar-task logo-avatar-monitor">
        <defs>
          <clipPath id={`screen-area-${id}`} clipPathUnits="userSpaceOnUse">
            <rect
              className="logo-avatar-safe-area"
              x="25"
              y="74.5"
              width="50"
              height="20"
              rx="1"
              fill="white"
              stroke="none"
            />
          </clipPath>
        </defs>
        <rect className="logo-avatar-task-surface" x="22" y="72" width="56" height="24" rx="3" />
        <path className="logo-avatar-task-detail" d="M47 96V98M39 98H61" />
        <g className="logo-avatar-task-ink" clipPath={`url(#screen-area-${id})`}>
          <rect
            className="logo-avatar-selection logo-avatar-action logo-avatar-task-detail"
            x="53"
            y="80"
            width="16"
            height="11"
            rx="1"
          />
          <g transform="translate(31 75)">
            <g className="logo-avatar-pointer logo-avatar-action">
              <path
                className="logo-avatar-pointer-fill"
                d="M0 0V14L3.5 10.5L8 16L11 14L7 8.5L14 7Z"
              />
            </g>
          </g>
        </g>
      </g>
    );
  return null;
}

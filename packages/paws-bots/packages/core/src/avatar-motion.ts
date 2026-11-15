/**
 * Shared working-avatar choreography used by mobile (Reanimated) and mirrored
 * by web CSS in `@rakazo/ui-web` (`styles.css` organic working keyframes).
 *
 * Duration families and transform midpoints must stay aligned across surfaces.
 */

export interface WorkingAvatarFrame {
  translationX: number;
  translationY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  eyeOffsetX: number;
  eyeOffsetY: number;
}

/** Per shape-family loop length in ms — keep in sync with web CSS animation durations. */
export const WORKING_AVATAR_DURATIONS_MS = [
  1800, 1350, 1600, 2400, 2400, 1350, 1100, 1350, 1600, 1350,
] as const;

export function workingAvatarDuration(seed: number): number {
  "worklet";
  return WORKING_AVATAR_DURATIONS_MS[seed % 10] ?? 1800;
}

export function workingAvatarFrame(seed: number, progress: number): WorkingAvatarFrame {
  "worklet";
  const middle = (1 - Math.cos(progress * Math.PI * 2)) / 2;
  const frame: WorkingAvatarFrame = {
    translationX: 0,
    translationY: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    eyeOffsetX: 0,
    eyeOffsetY: 0,
  };

  switch (seed % 10) {
    case 0:
      frame.translationY = 2 - 5 * middle;
      frame.scaleX = 1.02 - 0.04 * middle;
      break;
    case 1:
      frame.translationY = 2 - 5 * middle;
      frame.scaleX = 1.04 - 0.08 * middle;
      frame.scaleY = 0.96 + 0.09 * middle;
      break;
    case 2:
    case 8:
      frame.translationX = -1 + 2 * middle;
      frame.rotation = -3 + 6 * middle;
      break;
    case 3:
    case 4:
      frame.scaleX = 0.98 + 0.06 * middle;
      frame.scaleY = 0.98 + 0.06 * middle;
      frame.rotation = -4 + 8 * middle;
      break;
    case 5:
    case 9:
      frame.scaleX = 1.04 - 0.08 * middle;
      frame.scaleY = 0.96 + 0.08 * middle;
      break;
    case 6:
      frame.scaleX = 0.96 + 0.1 * middle;
      frame.scaleY = 0.96 + 0.1 * middle;
      break;
    default:
      frame.rotation = -4 + 9 * middle;
  }

  const angle = progress * Math.PI * 2;
  switch (seed % 4) {
    case 0:
      frame.eyeOffsetX = Math.sin(angle) * 9;
      frame.eyeOffsetY = Math.cos(angle) * 2;
      break;
    case 1:
      frame.eyeOffsetX = Math.cos(angle) * 7;
      frame.eyeOffsetY = Math.sin(angle) * 4;
      break;
    case 2:
      frame.eyeOffsetX = Math.cos(angle) * 8;
      frame.eyeOffsetY = Math.sin(angle) * 3;
      break;
    default:
      frame.eyeOffsetX = Math.sin(angle * 2) * 6;
      frame.eyeOffsetY = Math.cos(angle * 2) * 3;
  }
  return frame;
}

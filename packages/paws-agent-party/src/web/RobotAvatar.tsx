import { ROBOT_PRESETS } from './robot-presets.js';

export function avatarIndex(id: string, avatarId?: number): number {
  if (Number.isInteger(avatarId) && avatarId! >= 0 && avatarId! < ROBOT_PRESETS.length) return avatarId!;
  return [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % ROBOT_PRESETS.length;
}
export function RobotAvatar({ id, avatarId, name = '', large = false }: { id: string; avatarId?: number; name?: string; large?: boolean }) {
  return <img className={`robot-avatar${large ? ' large' : ''}`} src={ROBOT_PRESETS[avatarIndex(id, avatarId)]} alt={name ? `${name}的机器人头像` : ''}/>;
}
export function AvatarPicker({ value, onChange }: { value: number; onChange(value: number): void }) {
  return <fieldset className="avatar-picker"><legend>选择机器人头像</legend><div className="avatar-grid">{ROBOT_PRESETS.map((src, index) => <button type="button" key={index} aria-label={`机器人头像 ${index + 1}`} aria-pressed={index === value} onClick={() => onChange(index)}><img src={src} alt=""/></button>)}</div><small>Bottts by <a href="https://bottts.com/" target="_blank" rel="noreferrer">Pablo Stanley</a> · 24 款预置头像</small></fieldset>;
}

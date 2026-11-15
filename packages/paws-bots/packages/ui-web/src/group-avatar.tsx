import type { BotAvatarSet } from "@rakazo/contracts";
import type { CSSProperties } from "react";
import { memo } from "react";
import { BotAvatar } from "./bot-avatar.js";
import { cn } from "./lib/utils.js";

export interface GroupAvatarMember {
  botId?: string;
  name?: string;
  color: string;
  avatarSet?: BotAvatarSet;
  status?: string;
}

export interface GroupAvatarProps {
  members: GroupAvatarMember[];
  size?: number;
  className?: string;
}

export const GroupAvatar = memo(function GroupAvatar({
  members,
  size = 38,
  className,
}: GroupAvatarProps) {
  const firstMember = members[0];
  if (!firstMember) {
    return (
      <div
        className={cn(
          "rakazo-group-avatar relative flex items-center justify-center rounded-full border border-border bg-muted text-muted-foreground",
          className,
        )}
        style={{ width: size, height: size, flex: "none" }}
      >
        <svg
          aria-hidden="true"
          style={{ width: Math.round(size * 0.48), height: Math.round(size * 0.48) }}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </div>
    );
  }

  if (members.length === 1) {
    return (
      <BotAvatar
        color={firstMember.color}
        avatarSet={firstMember.avatarSet}
        identity={firstMember.botId ?? firstMember.name}
        size={size}
        status={firstMember.status}
        className={cn("rakazo-group-avatar", className)}
      />
    );
  }

  const pair = members.length === 2;
  const miniSize = Math.round(size * (pair ? 0.65 : 0.54));
  const positions: CSSProperties[] = pair
    ? [
        { top: 0, left: 0 },
        { right: 0, bottom: 0 },
      ]
    : [
        { top: 0, left: (size - miniSize) / 2 },
        { bottom: 0, left: 0 },
        { right: 0, bottom: 0 },
      ];
  const visibleMembers = members.slice(0, pair || members.length === 3 ? members.length : 2);

  return (
    <div
      className={cn("rakazo-group-avatar relative rounded-full select-none", className)}
      style={{ width: size, height: size, flex: "none" }}
    >
      {visibleMembers.map((member, index) => (
        <div
          key={member.botId ?? index}
          className="absolute"
          style={{
            ...positions[index],
            zIndex: index + 1,
            filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.6))",
          }}
        >
          <BotAvatar
            color={member.color}
            avatarSet={member.avatarSet}
            identity={member.botId ?? member.name}
            size={miniSize}
            status={member.status}
          />
        </div>
      ))}
      {members.length > 3 ? (
        <div
          // off-scale: count must fit the mini avatar dot
          className="absolute right-0 bottom-0 z-[3] flex items-center justify-center rounded-full bg-secondary border border-border text-[10px] font-semibold text-secondary-foreground shadow-md"
          style={{
            width: miniSize,
            height: miniSize,
          }}
        >
          {`+${members.length - 2}`}
        </div>
      ) : null}
    </div>
  );
});

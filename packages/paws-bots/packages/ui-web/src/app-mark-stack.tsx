import { useState } from "react";
import { cn } from "./lib/utils.js";

type AppMark = { name: string; logo?: string | null };

/** Decorative catalog artwork; the containing control supplies its accessible name. */
export function AppMarkStack({
  marks,
  size = 24,
  ringClassName,
}: {
  marks: readonly AppMark[];
  size?: number;
  /** Match the containing surface, including its hover state. */
  ringClassName: string;
}) {
  return (
    <span aria-hidden="true" className="isolate flex shrink-0 items-center">
      {marks.map((mark, index) => (
        <AppMarkTile
          key={mark.name}
          mark={mark}
          size={size}
          index={index}
          ringClassName={ringClassName}
        />
      ))}
    </span>
  );
}

function AppMarkTile({
  mark,
  size,
  index,
  ringClassName,
}: {
  mark: AppMark;
  size: number;
  index: number;
  ringClassName: string;
}) {
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  return (
    <span
      className={cn(
        // The shared white icon plate keeps catalog artwork readable in either theme.
        "grid shrink-0 place-items-center overflow-hidden rounded-full bg-favicon-plate font-medium text-foreground ring-2 outline-1 -outline-offset-1 outline-border dark:text-background",
        ringClassName,
      )}
      style={{
        width: size,
        height: size,
        padding: size / 6,
        fontSize: size / 2,
        marginLeft: index ? -size / 12 : 0,
        // Later tiles and their separating rings consistently sit above earlier tiles.
        zIndex: index,
      }}
    >
      {mark.logo && failedLogo !== mark.logo ? (
        <img
          src={mark.logo}
          alt=""
          className="size-full object-contain"
          onError={() => setFailedLogo(mark.logo ?? null)}
        />
      ) : (
        (mark.name.trim()[0] || "?").toUpperCase()
      )}
    </span>
  );
}

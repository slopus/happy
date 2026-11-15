import { useLingui } from "@lingui/react/macro";
import { Spinner } from "@rakazo/ui-web";

/** A whole-page wait. The spinner fades in late, so a quick load paints nothing in between. */
export function PageLoading(props: React.ComponentPropsWithoutRef<"div">) {
  const { t } = useLingui();
  return (
    <div className="grid h-full place-items-center bg-background" {...props}>
      <span className="animate-in fade-in-0 fill-mode-both delay-500 duration-300 motion-reduce:animate-none">
        <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
      </span>
    </div>
  );
}

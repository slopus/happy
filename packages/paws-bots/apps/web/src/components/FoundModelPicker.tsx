import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  ListSearchInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { useRef, useState } from "react";
import { useListSearch } from "../lib/use-list-search";

export function FoundModelPicker({
  models,
  value,
  onChange,
  otherValue,
}: {
  models: readonly string[];
  value: string;
  onChange: (value: string) => void;
  otherValue: string;
}) {
  const { t } = useLingui();
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const { query, setQuery, showSearch, visible } = useListSearch(models, { text: (id) => id });
  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={<Button variant="outline" className="mt-2 w-full justify-start" />}
        aria-label={t`Models from server`}
      >
        {value}
      </PopoverTrigger>
      <PopoverContent
        initialFocus={showSearch ? searchRef : undefined}
        className="gap-0 p-0"
        align="start"
      >
        <Command
          label={t`Search models`}
          tabIndex={showSearch ? undefined : 0}
          shouldFilter={false}
        >
          {showSearch ? (
            <ListSearchInput
              command
              inputRef={searchRef}
              query={query}
              setQuery={setQuery}
              label={t`Search models`}
              placeholder={t`Search`}
            />
          ) : null}
          <CommandList label={t`Model options`}>
            <CommandGroup>
              {visible.map((id) => (
                <CommandItem key={id} value={id} onSelect={() => pick(id)}>
                  {id}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup>
              <CommandItem value={otherValue} onSelect={() => pick(otherValue)}>
                <Trans>Other model…</Trans>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

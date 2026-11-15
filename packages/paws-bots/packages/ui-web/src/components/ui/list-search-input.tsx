import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import type { Ref } from "react";
import { InputGroup, InputGroupAddon } from "./input-group";

export function ListSearchInput({
  query,
  setQuery,
  label,
  placeholder,
  inputRef,
  command = false,
}: {
  query: string;
  setQuery: (query: string) => void;
  label: string;
  placeholder: string;
  inputRef?: Ref<HTMLInputElement>;
  command?: boolean;
}) {
  const props = {
    ref: inputRef,
    value: query,
    "aria-label": label,
    placeholder,
    autoComplete: "off",
    "data-slot": "input-group-control",
    className:
      "min-w-0 flex-1 bg-transparent py-1 pr-2 text-body outline-none disabled:cursor-not-allowed disabled:opacity-50",
  };

  return (
    <InputGroup className="shrink-0 h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
      <InputGroupAddon>
        <Search className="size-4 shrink-0 opacity-50" aria-hidden="true" />
      </InputGroupAddon>
      {command ? (
        <CommandPrimitive.Input {...props} onValueChange={setQuery} />
      ) : (
        <input {...props} onChange={(event) => setQuery(event.target.value)} />
      )}
    </InputGroup>
  );
}

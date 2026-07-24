import * as React from 'react';
import { DropdownMenu, DropdownMenuItem } from '@expo/ui/jetpack-compose';
import type { NativeOptionsPickerProps } from './NativeOptionsPicker';

export function NativeOptionsPicker({
    options,
    selectedKey,
    onSelect,
    children,
}: NativeOptionsPickerProps) {
    return (
        <DropdownMenu>
            <DropdownMenu.Items>
                {options.map((option) => (
                    <DropdownMenuItem key={option.key} onClick={() => onSelect(option.key)}>
                        <DropdownMenuItem.Text>
                            {option.key === selectedKey ? `✓ ${option.label}` : option.label}
                        </DropdownMenuItem.Text>
                    </DropdownMenuItem>
                ))}
            </DropdownMenu.Items>
            <DropdownMenu.Trigger>{children}</DropdownMenu.Trigger>
        </DropdownMenu>
    );
}

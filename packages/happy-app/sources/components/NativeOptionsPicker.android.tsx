import * as React from 'react';
import { DropdownMenu, DropdownMenuItem, Text as ComposeText } from '@expo/ui/jetpack-compose';
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
                        {/* Native slot view: a bare string child throws "Text strings
                            must be rendered within a <Text> component" mid-render. */}
                        <DropdownMenuItem.Text>
                            <ComposeText>
                                {option.key === selectedKey ? `✓ ${option.label}` : option.label}
                            </ComposeText>
                        </DropdownMenuItem.Text>
                    </DropdownMenuItem>
                ))}
            </DropdownMenu.Items>
            <DropdownMenu.Trigger>{children}</DropdownMenu.Trigger>
        </DropdownMenu>
    );
}

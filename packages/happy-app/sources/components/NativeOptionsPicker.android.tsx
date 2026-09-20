import * as React from 'react';
import { DropdownMenu, DropdownMenuItem, Text as ComposeText } from '@expo/ui/jetpack-compose';
import type { NativeOptionsPickerProps } from './NativeOptionsPicker';

export function NativeOptionsPicker({
    sections,
    selectedKey,
    onSelect,
    children,
}: NativeOptionsPickerProps) {
    return (
        <DropdownMenu>
            <DropdownMenu.Items>
                {sections.flatMap((section) => [
                    // Compose menus have no section headers, so a heading is a
                    // row that cannot be chosen.
                    ...(section.title ? [(
                        <DropdownMenuItem key={`${section.key}:title`} enabled={false} onClick={() => {}}>
                            <DropdownMenuItem.Text>
                                <ComposeText>{section.title}</ComposeText>
                            </DropdownMenuItem.Text>
                        </DropdownMenuItem>
                    )] : []),
                    ...section.options.map((option) => (
                        <DropdownMenuItem
                            key={`${section.key}:${option.key}`}
                            enabled={option.disabled !== true}
                            onClick={() => onSelect(option.key)}
                        >
                            {/* Native slot view: a bare string child throws "Text strings
                                must be rendered within a <Text> component" mid-render. */}
                            <DropdownMenuItem.Text>
                                <ComposeText>
                                    {!option.action && option.key === selectedKey ? `✓ ${option.label}` : option.label}
                                </ComposeText>
                            </DropdownMenuItem.Text>
                        </DropdownMenuItem>
                    )),
                ])}
            </DropdownMenu.Items>
            <DropdownMenu.Trigger>{children}</DropdownMenu.Trigger>
        </DropdownMenu>
    );
}

import * as React from 'react';
import { DropdownMenu, DropdownMenuItem, Text as ComposeText } from '@expo/ui/jetpack-compose';
import { View } from 'react-native';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu';

export function NativeSettingsMenu({ groups, children, style, flat = false }: NativeSettingsMenuProps) {
    return (
        <View style={style}>
            <DropdownMenu>
                <DropdownMenu.Items>
                    {groups.flatMap((group) => group.options.map((option) => (
                        <DropdownMenuItem
                            key={`${group.key}:${option.key}`}
                            enabled={!option.disabled}
                            onClick={() => group.onSelect(option.key)}
                        >
                            {/* The slot is a native view, so a bare string child makes
                                React Native throw "Text strings must be rendered within
                                a <Text> component" once per option while the menu
                                renders. Compose's own Text turns children into the
                                native `text` prop instead. */}
                            <DropdownMenuItem.Text>
                                <ComposeText>
                                    {`${flat ? '' : `${group.label}: `}${option.key === group.selectedKey ? '✓ ' : ''}${option.label}`}
                                </ComposeText>
                            </DropdownMenuItem.Text>
                        </DropdownMenuItem>
                    )))}
                </DropdownMenu.Items>
                <DropdownMenu.Trigger>{children}</DropdownMenu.Trigger>
            </DropdownMenu>
        </View>
    );
}

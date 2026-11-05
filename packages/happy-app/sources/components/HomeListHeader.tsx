import * as React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import { OfflineMachinesBanner } from './OfflineMachinesBanner';
import { UpdateBanner } from './UpdateBanner';
import { SessionSearchInput } from './SessionSearchInput';

/**
 * Everything that sits above the session rows, in one place so the flat list
 * and the project list show the same notices at the same width. The offline
 * plaque comes first: it is about right now, the update can wait a moment.
 * The search box, when open, sits under them, right above the rows it filters.
 */
export const HomeListHeader = React.memo(({
    style,
    headerStyle,
}: {
    style?: StyleProp<ViewStyle>;
    headerStyle?: StyleProp<ViewStyle>;
}) => (
    <>
        <OfflineMachinesBanner style={style} headerStyle={headerStyle} />
        <UpdateBanner style={style} headerStyle={headerStyle} />
        <SessionSearchInput />
    </>
));

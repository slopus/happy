import * as React from 'react';
import { View } from 'react-native';
import { Redirect } from 'expo-router';

/**
 * Non-web platforms redirect to home - task manager is web-only.
 */
export default React.memo(function TasksRedirect() {
    return <Redirect href="/" />;
});

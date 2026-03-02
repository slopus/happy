import * as React from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import { LessonView } from '@/learn/components/LessonView';

export default function LessonScreen() {
    const { id, t } = useLocalSearchParams<{ id: string; t?: string }>();
    const startTime = t ? parseInt(t, 10) : undefined;
    return (
        <>
            <Stack.Screen options={{ headerTitle: '' }} />
            <LessonView lessonId={id!} startTime={startTime} />
        </>
    );
}

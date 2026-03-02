import * as React from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import { CourseDetailView } from '@/learn/components/CourseDetailView';

export default function CourseScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return (
        <>
            <Stack.Screen options={{ headerTitle: '' }} />
            <CourseDetailView courseId={id!} />
        </>
    );
}

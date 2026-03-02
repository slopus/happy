import * as React from 'react';
import { Stack } from 'expo-router';
import { FlashcardReview } from '@/learn/components/FlashcardReview';

export default function ReviewScreen() {
    return (
        <>
            <Stack.Screen options={{ headerTitle: 'Review' }} />
            <FlashcardReview />
        </>
    );
}

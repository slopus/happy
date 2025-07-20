import React from 'react';
import { View } from 'react-native';
import { useIsTablet } from '@/utils/responsive';

interface SplitViewProps {
    master: React.ReactNode;
    detail: React.ReactNode;
    showDetail?: boolean;
    className?: string;
}

export function SplitView({ 
    master, 
    detail, 
    showDetail = false,
    className = ''
}: SplitViewProps) {
    const isTablet = useIsTablet();

    // On phones, show either master or detail based on showDetail
    if (!isTablet) {
        return (
            <View className={`flex-1 ${className}`}>
                {showDetail ? detail : master}
            </View>
        );
    }

    // On tablets, show split view
    return (
        <View className={`flex-1 flex-row ${className}`}>
            {/* Master panel - Sessions list */}
            <View className="w-full md:w-[40%] lg:w-[35%] md:max-w-[400px] md:min-w-[320px] bg-white dark:bg-gray-900 md:border-r border-gray-200 dark:border-gray-700">
                {master}
            </View>
            
            {/* Detail panel - Chat view */}
            <View className="hidden md:flex flex-1 bg-white dark:bg-gray-900">
                {detail}
            </View>
        </View>
    );
}
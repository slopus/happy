import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { ShimmerView } from '@/components/ShimmerView';
import { ItemGroup } from '@/components/ItemGroup';
import { Ionicons } from '@expo/vector-icons';

export default function ShimmerDemoScreen() {
    return (
        <>
            <Stack.Screen
                options={{
                    headerTitle: 'Shimmer View Demo',
                }}
            />
            
            <ScrollView style={styles.container}>
                <View style={styles.content}>
                    <Text style={styles.pageTitle}>Shimmer View Examples</Text>
                    <Text style={styles.description}>
                        Various examples of shimmer effects using children as masks
                    </Text>

                    <ItemGroup title="Text Shimmer">
                        <View style={styles.example}>
                            <ShimmerView style={styles.shimmerContainer}>
                                <Text style={styles.shimmerText}>Loading Content...</Text>
                            </ShimmerView>
                        </View>

                        <View style={styles.example}>
                            <ShimmerView 
                                style={styles.wideShimmerContainer}
                                shimmerColors={['#D0D0D0', '#E8E8E8', '#FFFFFF', '#E8E8E8', '#D0D0D0']}
                            >
                                <View>
                                    <Text style={styles.titleText}>Awesome Title</Text>
                                    <Text style={styles.subtitleText}>This is a subtitle with shimmer effect</Text>
                                </View>
                            </ShimmerView>
                        </View>
                    </ItemGroup>

                    <ItemGroup title="Icon Shimmer">
                        <View style={styles.example}>
                            <ShimmerView style={styles.iconShimmerContainer} duration={1000}>
                                <View style={styles.iconContainer}>
                                    <Ionicons name="logo-react" size={80} color="#61DAFB" />
                                </View>
                            </ShimmerView>
                        </View>
                    </ItemGroup>

                    <ItemGroup title="Card Skeleton">
                        <View style={styles.example}>
                            <ShimmerView style={styles.cardShimmerContainer}>
                                <View style={styles.card}>
                                    <View style={styles.cardHeader}>
                                        <View style={styles.avatar} />
                                        <View style={styles.cardInfo}>
                                            <View style={styles.nameLine} />
                                            <View style={styles.dateLine} />
                                        </View>
                                    </View>
                                    <View style={styles.cardContent}>
                                        <View style={styles.contentLine} />
                                        <View style={[styles.contentLine, { width: '80%' }]} />
                                    </View>
                                </View>
                            </ShimmerView>
                        </View>
                    </ItemGroup>

                    <ItemGroup title="Custom Colors">
                        <View style={styles.example}>
                            <ShimmerView 
                                style={styles.shimmerContainer}
                                shimmerColors={['#FFE4E1', '#FFF0F5', '#FFFFFF', '#FFF0F5', '#FFE4E1']}
                                duration={2000}
                            >
                                <Text style={[styles.shimmerText, { color: '#FF69B4' }]}>
                                    Pink Shimmer
                                </Text>
                            </ShimmerView>
                        </View>

                        <View style={styles.example}>
                            <ShimmerView 
                                style={styles.shimmerContainer}
                                shimmerColors={['#E0F2F1', '#B2DFDB', '#80CBC4', '#B2DFDB', '#E0F2F1']}
                                shimmerWidthPercent={120}
                            >
                                <Text style={[styles.shimmerText, { color: '#009688' }]}>
                                    Teal Shimmer
                                </Text>
                            </ShimmerView>
                        </View>
                    </ItemGroup>

                    <ItemGroup title="Complex Shapes">
                        <View style={styles.example}>
                            <ShimmerView style={styles.complexShimmerContainer}>
                                <View style={styles.complexShape}>
                                    <View style={styles.circle} />
                                    <View style={styles.rectangle} />
                                    <View style={styles.smallCircle} />
                                </View>
                            </ShimmerView>
                        </View>
                    </ItemGroup>

                    <ItemGroup title="Full Width Example">
                        <View style={styles.example}>
                            <ShimmerView style={styles.fullWidthContainer}>
                                <View style={styles.fullWidthContent}>
                                    <Text style={styles.fullWidthText}>Full Width Shimmer Effect</Text>
                                </View>
                            </ShimmerView>
                        </View>
                    </ItemGroup>
                </View>
            </ScrollView>
        </>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#F2F2F7',
    },
    content: {
        flex: 1,
        paddingBottom: 40,
    },
    pageTitle: {
        fontSize: 28,
        fontWeight: 'bold',
        marginTop: 20,
        marginBottom: 8,
        paddingHorizontal: 16,
    },
    description: {
        fontSize: 16,
        color: '#666',
        marginBottom: 20,
        paddingHorizontal: 16,
    },
    example: {
        paddingVertical: 20,
        paddingHorizontal: 16,
        alignItems: 'center',
        backgroundColor: '#FFFFFF',
    },
    shimmerText: {
        fontSize: 24,
        fontWeight: 'bold',
        color: '#333',
    },
    titleText: {
        fontSize: 28,
        fontWeight: 'bold',
        color: '#000',
        marginBottom: 8,
    },
    subtitleText: {
        fontSize: 16,
        color: '#666',
    },
    iconContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    card: {
        flex: 1,
        padding: 16,
    },
    cardHeader: {
        flexDirection: 'row',
        marginBottom: 16,
    },
    avatar: {
        width: 50,
        height: 50,
        borderRadius: 25,
        backgroundColor: '#888',
        marginRight: 12,
    },
    cardInfo: {
        flex: 1,
        justifyContent: 'center',
    },
    nameLine: {
        height: 16,
        backgroundColor: '#888',
        borderRadius: 4,
        marginBottom: 8,
        width: '60%',
    },
    dateLine: {
        height: 12,
        backgroundColor: '#888',
        borderRadius: 4,
        width: '40%',
    },
    cardContent: {
        gap: 8,
    },
    contentLine: {
        height: 12,
        backgroundColor: '#888',
        borderRadius: 4,
        width: '100%',
    },
    complexShape: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    circle: {
        width: 100,
        height: 100,
        borderRadius: 50,
        backgroundColor: '#888',
        marginBottom: 20,
    },
    rectangle: {
        width: 150,
        height: 40,
        backgroundColor: '#888',
        borderRadius: 8,
        marginBottom: 20,
    },
    smallCircle: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: '#888',
    },
    shimmerContainer: {
        width: 300,
        height: 60,
    },
    wideShimmerContainer: {
        width: 350,
        height: 100,
    },
    iconShimmerContainer: {
        width: 100,
        height: 100,
    },
    cardShimmerContainer: {
        width: 350,
        height: 120,
    },
    complexShimmerContainer: {
        width: 200,
        height: 200,
    },
    fullWidthContainer: {
        width: '100%',
        height: 80,
    },
    fullWidthContent: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    fullWidthText: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#333',
    },
});
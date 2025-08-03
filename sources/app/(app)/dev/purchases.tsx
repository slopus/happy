import * as React from 'react';
import { View, Text } from 'react-native';
import { Stack } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';

export default function PurchasesDevScreen() {
    // Get purchases directly from storage
    const purchases = storage(state => state.purchases);
    
    // Sort entitlements alphabetically
    const sortedEntitlements = React.useMemo(() => {
        return Object.entries(purchases.entitlements).sort(([a], [b]) => a.localeCompare(b));
    }, [purchases.entitlements]);
    
    return (
        <>
            <Stack.Screen 
                options={{
                    title: 'Purchases',
                    headerShown: true
                }}
            />
            
            <ItemList>
                    {/* Active Subscriptions */}
                    <ItemGroup 
                        title="Active Subscriptions"
                        footer={purchases.activeSubscriptions.length === 0 ? "No active subscriptions" : undefined}
                    >
                        {purchases.activeSubscriptions.length > 0 ? (
                            purchases.activeSubscriptions.map((productId, index) => (
                                <Item
                                    key={index}
                                    title={productId}
                                    icon={<Ionicons name="checkmark-circle" size={29} color="#34C759" />}
                                    showChevron={false}
                                />
                            ))
                        ) : null}
                    </ItemGroup>
                    
                    {/* Entitlements */}
                    <ItemGroup 
                        title="Entitlements"
                        footer={sortedEntitlements.length === 0 ? "No entitlements found" : "Green = active, Gray = inactive"}
                    >
                        {sortedEntitlements.length > 0 ? (
                            sortedEntitlements.map(([id, isActive]) => (
                                <Item
                                    key={id}
                                    title={id}
                                    icon={
                                        <Ionicons 
                                            name={isActive ? "checkmark-circle" : "close-circle"} 
                                            size={29} 
                                            color={isActive ? "#34C759" : "#8E8E93"} 
                                        />
                                    }
                                    detail={isActive ? "Active" : "Inactive"}
                                    showChevron={false}
                                />
                            ))
                        ) : null}
                    </ItemGroup>
                    
                    {/* Actions */}
                    <ItemGroup title="Actions">
                        <Item
                            title="Refresh Purchases"
                            icon={<Ionicons name="refresh-outline" size={29} color="#007AFF" />}
                            onPress={() => sync.refreshPurchases()}
                        />
                    </ItemGroup>
                    
                    {/* Debug Info */}
                    <ItemGroup title="Debug Info">
                        <Item
                            title="User ID"
                            detail={sync.pubID || "Not available"}
                            showChevron={false}
                        />
                    </ItemGroup>
                </ItemList>
        </>
    );
}
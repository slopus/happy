import * as React from 'react';
import { View, Text, TextInput, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { Modal } from '@/modal';

export default function PurchasesDevScreen() {
    // Get purchases directly from storage
    const purchases = storage(state => state.purchases);
    
    // State for purchase form
    const [productId, setProductId] = React.useState('');
    const [isPurchasing, setIsPurchasing] = React.useState(false);
    
    // Sort entitlements alphabetically
    const sortedEntitlements = React.useMemo(() => {
        return Object.entries(purchases.entitlements).sort(([a], [b]) => a.localeCompare(b));
    }, [purchases.entitlements]);
    
    const handlePurchase = async () => {
        if (!productId.trim()) {
            Modal.alert('Error', 'Please enter a product ID');
            return;
        }
        
        setIsPurchasing(true);
        try {
            const result = await sync.purchaseProduct(productId.trim());
            if (result.success) {
                Modal.alert('Success', 'Purchase completed successfully');
                setProductId('');
            } else {
                Modal.alert('Purchase Failed', result.error || 'Unknown error');
            }
        } finally {
            setIsPurchasing(false);
        }
    };
    
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
                    
                    {/* Purchase Product */}
                    <ItemGroup title="Purchase Product" footer="Enter a product ID to purchase">
                        <View style={{ 
                            backgroundColor: '#fff',
                            paddingHorizontal: 16,
                            paddingVertical: 12
                        }}>
                            <TextInput
                                value={productId}
                                onChangeText={setProductId}
                                placeholder="Enter product ID"
                                style={{
                                    fontSize: 17,
                                    paddingVertical: 8,
                                    paddingHorizontal: 12,
                                    backgroundColor: '#F2F2F7',
                                    borderRadius: 8,
                                    marginBottom: 12,
                                    ...Typography.default()
                                }}
                                editable={!isPurchasing}
                                autoCapitalize="none"
                                autoCorrect={false}
                            />
                            <Item
                                title={isPurchasing ? "Purchasing..." : "Purchase"}
                                icon={isPurchasing ? 
                                    <ActivityIndicator size="small" color="#007AFF" /> : 
                                    <Ionicons name="card-outline" size={29} color="#007AFF" />
                                }
                                onPress={handlePurchase}
                                disabled={isPurchasing}
                                showChevron={false}
                            />
                        </View>
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
                            title="RevenueCat Status"
                            detail={sync.revenueCatInitialized ? "Initialized" : "Not Initialized"}
                            showChevron={false}
                        />
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
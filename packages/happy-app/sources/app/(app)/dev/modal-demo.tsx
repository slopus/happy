import React from 'react';
import { View, Text, StyleSheet, ScrollView, Platform } from 'react-native';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';

// Example custom modal component
function CustomContentModal({ onClose, title, message }: { onClose: () => void; title: string; message: string }) {
    return (
        <View style={styles.customModal}>
            <Text style={[styles.customModalTitle, Typography.default('semiBold')]}>{title}</Text>
            <Text style={[styles.customModalMessage, Typography.default()]}>{message}</Text>
            <View style={styles.customModalButtons}>
                <RoundButton
                    title="Close"
                    onPress={onClose}
                    size="normal"
                />
            </View>
        </View>
    );
}

export default function ModalDemoScreen() {
    const [lastResult, setLastResult] = React.useState<string>('No action taken yet');

    const showSimpleAlert = () => {
        Modal.alert('Simple Alert', 'This is a simple alert modal.');
        setLastResult('Showed simple alert');
    };

    const showAlertWithMessage = () => {
        Modal.alert(
            'Alert with Message',
            'This alert has a longer message that explains something in detail. It can span multiple lines if needed.'
        );
        setLastResult('Showed alert with message');
    };

    const showAlertWithButtons = () => {
        Modal.alert(
            'Multiple Actions',
            'Choose an action:',
            [
                { text: 'Cancel', style: 'cancel', onPress: () => setLastResult('Pressed Cancel') },
                { text: 'Option 1', onPress: () => setLastResult('Pressed Option 1') },
                { text: 'Option 2', onPress: () => setLastResult('Pressed Option 2') }
            ]
        );
    };

    const showConfirm = async () => {
        const result = await Modal.confirm(
            'Confirm Action',
            'Are you sure you want to proceed?'
        );
        setLastResult(`Confirm result: ${result ? 'Confirmed' : 'Cancelled'}`);
    };

    const showDestructiveConfirm = async () => {
        const result = await Modal.confirm(
            'Delete Item',
            'This action cannot be undone. Are you sure?',
            {
                confirmText: 'Delete',
                cancelText: 'Keep',
                destructive: true
            }
        );
        setLastResult(`Delete result: ${result ? 'Deleted' : 'Kept'}`);
    };

    const showCustomModal = () => {
        Modal.show({
            component: CustomContentModal,
            props: {
                title: 'Custom Modal',
                message: 'This is a completely custom modal component. You can put anything in here!'
            }
        });
        setLastResult('Showed custom modal');
    };

    const showMultipleModals = async () => {
        Modal.alert('First Modal', 'This is the first modal');
        
        setTimeout(() => {
            Modal.alert('Second Modal', 'This modal appeared after the first one');
        }, 1500);
        
        setLastResult('Showed multiple modals');
    };

    return (
        <ScrollView style={styles.container}>
            <View style={styles.header}>
                <Text style={[styles.title, Typography.default('semiBold')]}>Modal Demo</Text>
                <Text style={[styles.subtitle, Typography.default()]}>
                    Platform: {Platform.OS} ({Platform.OS === 'web' ? 'Custom modals' : 'Native alerts'})
                </Text>
            </View>

            <ItemList>
                <ItemGroup title="Alert Modals">
                    <Item
                        title="Simple Alert"
                        subtitle="Basic alert with title only"
                        onPress={showSimpleAlert}
                    />
                    <Item
                        title="Alert with Message"
                        subtitle="Alert with title and message"
                        onPress={showAlertWithMessage}
                    />
                    <Item
                        title="Alert with Multiple Buttons"
                        subtitle="Alert with custom buttons"
                        onPress={showAlertWithButtons}
                    />
                </ItemGroup>

                <ItemGroup title="Confirmation Modals">
                    <Item
                        title="Basic Confirmation"
                        subtitle="Simple yes/no confirmation"
                        onPress={showConfirm}
                    />
                    <Item
                        title="Destructive Confirmation"
                        subtitle="Confirmation with destructive action"
                        onPress={showDestructiveConfirm}
                        destructive
                    />
                </ItemGroup>

                <ItemGroup title="Custom Modals">
                    <Item
                        title="Custom Modal"
                        subtitle="Fully custom modal component"
                        onPress={showCustomModal}
                    />
                    <Item
                        title="Multiple Modals"
                        subtitle="Show multiple modals in sequence"
                        onPress={showMultipleModals}
                    />
                </ItemGroup>

                <ItemGroup title="Last Action Result">
                    <View style={styles.resultContainer}>
                        <Text style={[styles.resultText, Typography.default()]}>
                            {lastResult}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#F2F2F7'
    },
    header: {
        padding: 20,
        backgroundColor: '#fff',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: '#E5E5E7'
    },
    title: {
        fontSize: 24,
        marginBottom: 4
    },
    subtitle: {
        fontSize: 14,
        color: '#8E8E93'
    },
    resultContainer: {
        padding: 16,
        backgroundColor: '#fff'
    },
    resultText: {
        fontSize: 16,
        color: '#007AFF'
    },
    customModal: {
        backgroundColor: '#fff',
        borderRadius: 12,
        padding: 20,
        width: 300,
        alignItems: 'center'
    },
    customModalTitle: {
        fontSize: 20,
        marginBottom: 12
    },
    customModalMessage: {
        fontSize: 16,
        textAlign: 'center',
        marginBottom: 20,
        color: '#666'
    },
    customModalButtons: {
        width: '100%'
    }
});
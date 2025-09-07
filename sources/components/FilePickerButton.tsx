import * as React from 'react';
import { Platform, Alert } from 'react-native';
import { Pressable } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useUnistyles } from 'react-native-unistyles';
import { hapticsLight } from './haptics';

interface FilePickerButtonProps {
    sessionId?: string;
    onFileSelected?: (file: { uri: string, name: string, type: string, base64?: string }) => void;
}

export function FilePickerButton({ sessionId, onFileSelected }: FilePickerButtonProps) {
    const { theme } = useUnistyles();

    const handlePickDocument = async () => {
        try {
            const result = await DocumentPicker.getDocumentAsync({
                type: '*/*',
                copyToCacheDirectory: true,
            });

            if (!result.canceled && result.assets && result.assets.length > 0) {
                const file = result.assets[0];
                onFileSelected?.({
                    uri: file.uri,
                    name: file.name,
                    type: file.mimeType || 'application/octet-stream',
                });
            }
        } catch (error) {
            console.error('Error picking document:', error);
            Alert.alert('Error', 'Failed to pick document');
        }
    };

    const handlePickImage = async () => {
        try {
            const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
            
            if (status !== 'granted') {
                Alert.alert('Permission Required', 'Please grant photo library access to upload images.');
                return;
            }

            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ImagePicker.MediaTypeOptions.Images,
                allowsEditing: false,
                quality: 0.8,
                base64: true,
            });

            if (!result.canceled && result.assets && result.assets.length > 0) {
                const image = result.assets[0];
                onFileSelected?.({
                    uri: image.uri,
                    name: `image_${Date.now()}.${image.uri.split('.').pop()}`,
                    type: image.mimeType || 'image/jpeg',
                    base64: image.base64,
                });
            }
        } catch (error) {
            console.error('Error picking image:', error);
            Alert.alert('Error', 'Failed to pick image');
        }
    };

    const handlePress = () => {
        hapticsLight();
        
        // Show action sheet to choose between files and photos
        if (Platform.OS === 'ios') {
            Alert.alert(
                'Add Attachment',
                'Choose what to upload',
                [
                    { text: 'Photo Library', onPress: handlePickImage },
                    { text: 'Files', onPress: handlePickDocument },
                    { text: 'Cancel', style: 'cancel' }
                ]
            );
        } else {
            // Android: default to document picker which includes images
            handlePickDocument();
        }
    };

    if (!sessionId || !onFileSelected) {
        return null;
    }

    return (
        <Pressable
            style={(p) => ({
                flexDirection: 'row',
                alignItems: 'center',
                borderRadius: Platform.select({ default: 16, android: 20 }),
                paddingHorizontal: 8,
                paddingVertical: 6,
                height: 32,
                opacity: p.pressed ? 0.7 : 1,
                marginRight: 4,
            })}
            hitSlop={{ top: 5, bottom: 10, left: 5, right: 5 }}
            onPress={handlePress}
        >
            <Ionicons
                name="attach"
                size={20}
                color={theme.colors.button.secondary.tint}
            />
        </Pressable>
    );
}
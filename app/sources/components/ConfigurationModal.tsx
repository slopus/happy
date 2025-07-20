import React from 'react';
import { View, Text, Modal, Pressable, SafeAreaView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Toggle } from './Toggle';
import { useDebug } from '@/contexts/DebugContext';

interface ConfigurationModalProps {
  visible: boolean;
  onClose: () => void;
}

export const ConfigurationModal: React.FC<ConfigurationModalProps> = ({ visible, onClose }) => {
  const { showDebugInfo, toggleDebugInfo } = useDebug();

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: 'white' }}>
        <View style={{ flex: 1 }}>
          {/* Header */}
          <View style={{ 
            flexDirection: 'row', 
            alignItems: 'center', 
            justifyContent: 'space-between', 
            paddingHorizontal: 16, 
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: '#E5E7EB'
          }}>
            <Text style={{ fontSize: 18, fontWeight: '600', color: '#111827' }}>Configuration</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={24} color="#6B7280" />
            </Pressable>
          </View>

          {/* Content */}
          <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 24 }}>
            <View style={{ marginBottom: 24 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: '#111827', marginBottom: 16 }}>
                Developer Options
              </Text>
              
              <Toggle
                label="Show Debug Information"
                description="Display debug IDs and additional information throughout the app"
                checked={showDebugInfo}
                onChange={toggleDebugInfo}
              />
            </View>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}; 
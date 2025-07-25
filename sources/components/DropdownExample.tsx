import React from 'react';
import { View, Text, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Dropdown, DropdownOption } from './Dropdown';
import { RoundButton } from './RoundButton';
import { Typography } from '@/constants/Typography';

export const DropdownExample: React.FC = () => {
  const [selectedBasic, setSelectedBasic] = React.useState<string>('');
  const [selectedWithState, setSelectedWithState] = React.useState<string>('checkbox');
  const [isLoading, setIsLoading] = React.useState(false);

  const basicOptions: DropdownOption[] = [
    { label: 'Option 1', value: 'option1' },
    { label: 'Option 2', value: 'option2' },
    { label: 'Option 3', value: 'option3' },
    { label: 'Disabled Option', value: 'disabled', disabled: true },
  ];

  const stateOptions: DropdownOption[] = [
    { 
      label: 'Loading...', 
      value: 'loading',
      icon: <Ionicons name="refresh" size={24} color="#8E8E93" />,
      loading: true 
    },
    { 
      label: 'Checkbox Item', 
      value: 'checkbox',
      icon: <Ionicons name="checkmark-circle" size={24} color="#34C759" />
    },
    { 
      label: 'Set to loading', 
      value: 'set-loading',
      icon: <Ionicons name="time" size={24} color="#FF9500" />
    },
  ];

  const menuOptions: DropdownOption[] = [
    { 
      label: 'Edit', 
      value: 'edit',
      icon: <Ionicons name="pencil" size={24} color="#007AFF" />
    },
    { 
      label: 'Duplicate', 
      value: 'duplicate',
      icon: <Ionicons name="copy" size={24} color="#007AFF" />
    },
    { 
      label: 'Share', 
      value: 'share',
      icon: <Ionicons name="share" size={24} color="#007AFF" />
    },
    { 
      label: 'Delete', 
      value: 'delete',
      icon: <Ionicons name="trash" size={24} color="#FF3B30" />
    },
  ];

  const handleBasicSelect = (value: string) => {
    setSelectedBasic(value);
    Alert.alert('Selected', `You selected: ${value}`);
  };

  const handleStateSelect = (value: string) => {
    setSelectedWithState(value);
    
    if (value === 'set-loading') {
      setIsLoading(true);
      // Simulate async operation
      setTimeout(() => {
        setIsLoading(false);
        Alert.alert('Complete', 'Loading state cleared');
      }, 2000);
    } else {
      Alert.alert('Selected', `You selected: ${value}`);
    }
  };

  const handleMenuSelect = (value: string) => {
    Alert.alert('Action', `You selected: ${value}`);
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#F2F2F7', padding: 16 }}>
      {/* Header */}
      <Text 
        style={[
          Typography.default('semiBold'),
          { 
            fontSize: 24, 
            color: '#000000', 
            marginBottom: 8,
            textAlign: 'center'
          }
        ]}
      >
        Dropdown Menu
      </Text>
      
      {/* Buttons Row */}
      <View style={{ 
        flexDirection: 'row', 
        gap: 12, 
        marginBottom: 32,
        justifyContent: 'center'
      }}>
        <Dropdown
          options={basicOptions}
          selectedValue={selectedBasic}
          onSelect={handleBasicSelect}
          placeholder="Open Dropdown"
          buttonStyle={{
            backgroundColor: '#007AFF',
            borderColor: '#007AFF',
            paddingHorizontal: 24,
            paddingVertical: 12,
            borderRadius: 22,
          }}
        />
        
        <Dropdown
          options={stateOptions}
          selectedValue={selectedWithState}
          onSelect={handleStateSelect}
          placeholder="With State"
          loading={isLoading}
          buttonStyle={{
            backgroundColor: 'transparent',
            borderColor: '#007AFF',
            borderWidth: 1,
            paddingHorizontal: 24,
            paddingVertical: 12,
            borderRadius: 22,
          }}
        />
      </View>

      {/* Sub Menu Example */}
      <View style={{ marginBottom: 24 }}>
        <Text 
          style={[
            Typography.default('regular'),
            { 
              fontSize: 17, 
              color: '#000000', 
              marginBottom: 12,
            }
          ]}
        >
          Sub Menu
        </Text>
        
        <Dropdown
          options={stateOptions}
          selectedValue={selectedWithState}
          onSelect={handleStateSelect}
          placeholder="Select option"
          buttonStyle={{
            backgroundColor: '#FFFFFF',
            borderColor: '#C6C6C8',
            marginBottom: 16,
          }}
        />
      </View>

      {/* Action Menu Example */}
      <View style={{ marginBottom: 24 }}>
        <Text 
          style={[
            Typography.default('regular'),
            { 
              fontSize: 17, 
              color: '#000000', 
              marginBottom: 12,
            }
          ]}
        >
          Action Menu
        </Text>
        
        <Dropdown
          options={menuOptions}
          onSelect={handleMenuSelect}
          placeholder="Choose action..."
          buttonStyle={{
            backgroundColor: '#FFFFFF',
            borderColor: '#C6C6C8',
          }}
        />
      </View>

      {/* Info */}
      <View style={{
        backgroundColor: '#E7F3FF',
        padding: 16,
        borderRadius: 12,
        borderLeftWidth: 4,
        borderLeftColor: '#007AFF',
      }}>
        <Text style={[
          Typography.default('regular'),
          { fontSize: 15, color: '#1B4B87', lineHeight: 20 }
        ]}>
          💡 Tap any dropdown button to see the menu appear with smooth animations. 
          The dropdown automatically positions itself to stay within screen bounds.
        </Text>
      </View>
    </View>
  );
}; 
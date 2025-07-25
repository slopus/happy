import React from 'react';
import { View, Text, Alert, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Dropdown, DropdownOption } from '@/components/Dropdown';
import { Typography } from '@/constants/Typography';

export const DropdownExample: React.FC = () => {
  const [selectedBasic, setSelectedBasic] = React.useState<string>('');
  const [selectedWithState, setSelectedWithState] = React.useState<string>('checkbox');
  const [isLoading, setIsLoading] = React.useState(false);

  // Dropdown open states
  const [isBasicOpen, setIsBasicOpen] = React.useState(false);
  const [isStateOpen, setIsStateOpen] = React.useState(false);
  const [isSubMenuOpen, setIsSubMenuOpen] = React.useState(false);
  const [isActionMenuOpen, setIsActionMenuOpen] = React.useState(false);

  // Refs for trigger buttons
  const basicTriggerRef = React.useRef<View | null>(null);
  const stateTriggerRef = React.useRef<View | null>(null);
  const subMenuTriggerRef = React.useRef<View | null>(null);
  const actionMenuTriggerRef = React.useRef<View | null>(null);

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

  // Button component for triggers
  const DropdownButton: React.FC<{
    title: string;
    isPressed: boolean;
    onPress: () => void;
    style?: any;
    loading?: boolean;
    selectedValue?: string;
    triggerRef: React.RefObject<View | null>;
    textColor?: string;
  }> = ({ title, isPressed, onPress, style, loading, selectedValue, triggerRef, textColor }) => (
    <Pressable
      ref={triggerRef}
      onPress={onPress}
      style={({ pressed }) => [
        {
          backgroundColor: pressed || isPressed ? '#E3F2FD' : '#FFFFFF',
          borderColor: pressed || isPressed ? '#007AFF' : '#C6C6C8',
          borderWidth: 1,
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderRadius: 8,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          minHeight: 44,
        },
        style
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
        {loading && (
          <Ionicons 
            name="refresh" 
            size={16} 
            color="#8E8E93" 
            style={{ marginRight: 8 }} 
          />
        )}
                 <Text style={[
           Typography.default('regular'),
           { 
             fontSize: 16, 
             color: textColor || '#000000',
             flex: 1
           }
         ]}>
           {title}
         </Text>
      </View>
             <View style={{
         backgroundColor: isPressed ? '#007AFF' : '#F2F2F7',
         borderWidth: 1,
         borderColor: isPressed ? '#007AFF' : '#C6C6C8',
         borderRadius: 6,
         padding: 4,
         marginLeft: 8,
       }}>
         <Ionicons 
           name={isPressed ? "chevron-up" : "chevron-down"} 
           size={14} 
           color={isPressed ? '#FFFFFF' : '#1D1D1F'} 
         />
       </View>
    </Pressable>
  );

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
      }}>
        <DropdownButton
          title={selectedBasic ? basicOptions.find(opt => opt.value === selectedBasic)?.label || "Open Dropdown" : "Open Dropdown"}
          isPressed={isBasicOpen}
          onPress={() => setIsBasicOpen(!isBasicOpen)}
          selectedValue={selectedBasic}
          triggerRef={basicTriggerRef}
          textColor={isBasicOpen ? '#000000' : '#FFFFFF'}
          style={{
            flex: 1,
            backgroundColor: isBasicOpen ? '#E3F2FD' : '#007AFF',
            borderColor: '#007AFF',
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderRadius: 22,
          }}
        />
        
        <DropdownButton
          title={selectedWithState ? stateOptions.find(opt => opt.value === selectedWithState)?.label || "With State" : "With State"}
          isPressed={isStateOpen}
          onPress={() => setIsStateOpen(!isStateOpen)}
          selectedValue={selectedWithState}
          triggerRef={stateTriggerRef}
          loading={isLoading}
          style={{
            flex: 1,
            backgroundColor: isStateOpen ? '#E3F2FD' : 'transparent',
            borderColor: '#007AFF',
            borderWidth: 1,
            paddingHorizontal: 16,
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
        
        <DropdownButton
          title={selectedWithState ? stateOptions.find(opt => opt.value === selectedWithState)?.label || "Select option" : "Select option"}
          isPressed={isSubMenuOpen}
          onPress={() => setIsSubMenuOpen(!isSubMenuOpen)}
          selectedValue={selectedWithState}
          triggerRef={subMenuTriggerRef}
          style={{
            backgroundColor: isSubMenuOpen ? '#E3F2FD' : '#FFFFFF',
            borderColor: isSubMenuOpen ? '#007AFF' : '#C6C6C8',
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
        
        <DropdownButton
          title="Choose action..."
          isPressed={isActionMenuOpen}
          onPress={() => setIsActionMenuOpen(!isActionMenuOpen)}
          triggerRef={actionMenuTriggerRef}
          style={{
            backgroundColor: isActionMenuOpen ? '#E3F2FD' : '#FFFFFF',
            borderColor: isActionMenuOpen ? '#007AFF' : '#C6C6C8',
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

      {/* Dropdown Components */}
      <Dropdown
        options={basicOptions}
        selectedValue={selectedBasic}
        onSelect={handleBasicSelect}
        isOpen={isBasicOpen}
        onClose={() => setIsBasicOpen(false)}
        triggerRef={basicTriggerRef}
      />

      <Dropdown
        options={stateOptions}
        selectedValue={selectedWithState}
        onSelect={handleStateSelect}
        isOpen={isStateOpen}
        onClose={() => setIsStateOpen(false)}
        triggerRef={stateTriggerRef}
      />

      <Dropdown
        options={stateOptions}
        selectedValue={selectedWithState}
        onSelect={handleStateSelect}
        isOpen={isSubMenuOpen}
        onClose={() => setIsSubMenuOpen(false)}
        triggerRef={subMenuTriggerRef}
      />

      <Dropdown
        options={menuOptions}
        onSelect={handleMenuSelect}
        isOpen={isActionMenuOpen}
        onClose={() => setIsActionMenuOpen(false)}
        triggerRef={actionMenuTriggerRef}
      />
    </View>
  );
}; 

export default function DropdownDemoScreen() {
  return <DropdownExample />;
} 
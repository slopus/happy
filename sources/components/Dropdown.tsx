import React from 'react';
import { 
  View, 
  Text, 
  Pressable, 
  Modal, 
  Animated,
  Dimensions,
  Platform,
  LayoutChangeEvent 
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { Item } from './Item';
import { ItemGroup } from './ItemGroup';

export interface DropdownOption {
  label: string;
  value: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  loading?: boolean;
}

interface DropdownProps {
  options: DropdownOption[];
  selectedValue?: string;
  onSelect: (value: string) => void;
  isOpen: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<View | null>;
  dropdownStyle?: any;
  maxHeight?: number;
}

export const Dropdown: React.FC<DropdownProps> = ({
  options,
  selectedValue,
  onSelect,
  isOpen,
  onClose,
  triggerRef,
  dropdownStyle,
  maxHeight = 300
}) => {
  const [buttonLayout, setButtonLayout] = React.useState({ x: 0, y: 0, width: 0, height: 0 });
  const fadeAnim = React.useRef(new Animated.Value(0)).current;
  const scaleAnim = React.useRef(new Animated.Value(0.95)).current;

  React.useEffect(() => {
    if (isOpen) {
      // Measure the trigger position when opening
      triggerRef.current?.measure((x, y, width, height, pageX, pageY) => {
        setButtonLayout({ x: pageX, y: pageY, width, height });
      });

      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          tension: 100,
          friction: 8,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 100,
          useNativeDriver: true,
        }),
        Animated.timing(scaleAnim, {
          toValue: 0.95,
          duration: 100,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [isOpen]);

  const handleSelect = (value: string) => {
    onSelect(value);
    onClose();
  };

  const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
  
  // Calculate dropdown position
  const dropdownWidth = Math.min(buttonLayout.width, 300);
  const estimatedDropdownHeight = Math.min(options.length * 44 + 20, maxHeight);
  
  let dropdownLeft = buttonLayout.x;
  let dropdownTop = buttonLayout.y + buttonLayout.height + 4;
  
  // Adjust horizontal position if it goes off screen
  if (dropdownLeft + dropdownWidth > screenWidth - 16) {
    dropdownLeft = screenWidth - dropdownWidth - 16;
  }
  
  // Adjust vertical position if it goes off screen
  if (dropdownTop + estimatedDropdownHeight > screenHeight - 100) {
    dropdownTop = buttonLayout.y - estimatedDropdownHeight - 4;
  }

  return (
    <>
      {/* Dropdown Modal */}
      <Modal
        visible={isOpen}
        transparent
        animationType="none"
        onRequestClose={onClose}
      >
        <Pressable 
          style={{ flex: 1 }}
          onPress={onClose}
        >
          <Animated.View
            style={[
              {
                position: 'absolute',
                left: dropdownLeft,
                top: dropdownTop,
                width: dropdownWidth,
                maxHeight: maxHeight,
                opacity: fadeAnim,
                transform: [{ scale: scaleAnim }],
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 8 },
                shadowOpacity: 0.25,
                shadowRadius: 16,
                elevation: 8,
              },
              dropdownStyle
            ]}
          >
            <ItemGroup containerStyle={{ 
              backgroundColor: Platform.OS === 'ios' ? 'rgba(255,255,255,0.95)' : '#ffffff',
              backdropFilter: Platform.OS === 'web' ? 'blur(20px)' : undefined,
              maxHeight: maxHeight,
            }}>
              {options.map((option, index) => (
                <Item
                  key={option.value}
                  title={option.label}
                  icon={option.icon}
                  selected={option.value === selectedValue}
                  disabled={option.disabled}
                  loading={option.loading}
                  onPress={() => handleSelect(option.value)}
                  showChevron={false}
                  showDivider={index < options.length - 1}
                />
              ))}
            </ItemGroup>
          </Animated.View>
        </Pressable>
      </Modal>
    </>
  );
}; 
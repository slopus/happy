import React from 'react';
import { View, Text, Pressable, Animated } from 'react-native';

interface ToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

export const Toggle: React.FC<ToggleProps> = ({ label, description, checked, onChange }) => {
  const animatedValue = React.useRef(new Animated.Value(checked ? 1 : 0)).current;

  React.useEffect(() => {
    Animated.timing(animatedValue, {
      toValue: checked ? 1 : 0,
      duration: 200,
      useNativeDriver: false,
    }).start();
  }, [checked, animatedValue]);

  const translateX = animatedValue.interpolate({
    inputRange: [0, 1],
    outputRange: [2, 22],
  });

  const backgroundColor = animatedValue.interpolate({
    inputRange: [0, 1],
    outputRange: ['#E5E7EB', '#3B82F6'],
  });

  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
      <View style={{ flex: 1, flexDirection: 'column' }}>
        <Text style={{ fontSize: 14, fontWeight: '500', color: '#374151' }}>{label}</Text>
        {description && (
          <Text style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>{description}</Text>
        )}
      </View>
      <Pressable
        onPress={() => onChange(!checked)}
        style={{ marginTop: 4 }}
        hitSlop={10}
      >
        <Animated.View
          style={{
            width: 44,
            height: 24,
            borderRadius: 12,
            backgroundColor,
            justifyContent: 'center',
            position: 'relative',
          }}
        >
          <Animated.View
            style={{
              width: 20,
              height: 20,
              borderRadius: 10,
              backgroundColor: 'white',
              position: 'absolute',
              transform: [{ translateX }],
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 1 },
              shadowOpacity: 0.2,
              shadowRadius: 2,
              elevation: 2,
            }}
          />
        </Animated.View>
      </Pressable>
    </View>
  );
}; 
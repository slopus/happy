import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetView } from '@gorhom/bottom-sheet';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { DatePicker } from './DatePicker';

interface DatePickerSheetProps {
    date: Date;
    onChange: (date: Date) => void;
    minDate?: Date;
    timePicker?: boolean;
    title?: string;
}

export const DatePickerSheet = React.memo(React.forwardRef<BottomSheetModal, DatePickerSheetProps>(
    ({ date, onChange, minDate, timePicker = true, title }, ref) => {
        const { theme } = useUnistyles();
        const innerRef = React.useRef<BottomSheetModal>(null);
        const [draft, setDraft] = React.useState(date);

        // Store latest date prop in a ref so the onChange callback can read it without re-creating
        const dateRef = React.useRef(date);
        dateRef.current = date;

        // Sync draft when the date prop changes (e.g. switching between start/end)
        React.useEffect(() => { setDraft(date); }, [date]);

        // Wrap present() to reset draft before the sheet opens
        React.useImperativeHandle(ref, () => {
            const modal = innerRef.current!;
            return new Proxy(modal, {
                get(target, prop, receiver) {
                    if (prop === 'present') {
                        return (...args: any[]) => {
                            setDraft(dateRef.current);
                            return target.present(...args);
                        };
                    }
                    return Reflect.get(target, prop, receiver);
                },
            });
        }, []);

        const handleConfirm = React.useCallback(() => {
            onChange(draft);
            innerRef.current?.dismiss();
        }, [draft, onChange]);

        const renderBackdrop = React.useCallback(
            (props: any) => (
                <BottomSheetBackdrop
                    {...props}
                    appearsOnIndex={0}
                    disappearsOnIndex={-1}
                    pressBehavior="close"
                />
            ),
            [],
        );

        return (
            <BottomSheetModal
                ref={innerRef}
                snapPoints={['60%']}
                enableDynamicSizing={false}
                backdropComponent={renderBackdrop}
                backgroundStyle={{ backgroundColor: theme.colors.surface }}
                handleIndicatorStyle={{ backgroundColor: theme.colors.textSecondary }}
            >
                <BottomSheetView style={{ paddingHorizontal: 20 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        {title ? (
                            <Text style={{ ...Typography.default('semiBold'), fontSize: 16, color: theme.colors.text }}>
                                {title}
                            </Text>
                        ) : <View />}
                        <Pressable onPress={handleConfirm} hitSlop={8}>
                            <Text style={{ ...Typography.default('semiBold'), fontSize: 16, color: theme.colors.button.primary.background }}>
                                {t('common.ok')}
                            </Text>
                        </Pressable>
                    </View>
                    <DatePicker
                        date={draft}
                        onChange={setDraft}
                        minDate={minDate}
                        timePicker={timePicker}
                    />
                </BottomSheetView>
            </BottomSheetModal>
        );
    },
));

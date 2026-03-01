import * as React from 'react';
import DateTimePicker, { type DateType } from 'react-native-ui-datepicker';
import { useUnistyles } from 'react-native-unistyles';

interface DatePickerProps {
    date: Date;
    onChange: (date: Date) => void;
    minDate?: Date;
    timePicker?: boolean;
}

export const DatePicker = React.memo(function DatePicker({ date, onChange, minDate, timePicker = true }: DatePickerProps) {
    const { theme } = useUnistyles();

    const handleChange = React.useCallback(({ date: d }: { date: DateType }) => {
        if (d instanceof Date) {
            onChange(d);
        } else if (d) {
            onChange(new Date(d as string | number));
        }
    }, [onChange]);

    return (
        <DateTimePicker
            mode="single"
            date={date}
            onChange={handleChange}
            timePicker={timePicker}
            minDate={minDate}
            styles={{
                day_label: { color: theme.colors.text },
                today: { borderColor: theme.colors.button.primary.background, borderWidth: 1, borderRadius: 8 },
                today_label: { color: theme.colors.button.primary.background },
                selected: { backgroundColor: theme.colors.button.primary.background, borderRadius: 8 },
                selected_label: { color: theme.colors.button.primary.tint },
                month_selector_label: { color: theme.colors.text },
                year_selector_label: { color: theme.colors.text },
                time_selector_label: { color: theme.colors.text },
                weekday_label: { color: theme.colors.textSecondary },
                button_prev_image: { tintColor: theme.colors.text },
                button_next_image: { tintColor: theme.colors.text },
                time_label: { color: theme.colors.text },
                time_selected_indicator: { backgroundColor: theme.colors.button.primary.background + '20' },
                outside_label: { color: theme.colors.textSecondary },
                header: { paddingHorizontal: 0 },
                year_label: { color: theme.colors.text },
                month_label: { color: theme.colors.text },
                selected_year: { backgroundColor: theme.colors.button.primary.background },
                selected_year_label: { color: theme.colors.button.primary.tint },
                selected_month: { backgroundColor: theme.colors.button.primary.background },
                selected_month_label: { color: theme.colors.button.primary.tint },
            }}
        />
    );
});

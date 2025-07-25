import { Alert } from "react-native";

export function useAlert() {
    return alert;
}

function alert(title: string, message: string, buttons: { text: string, style?: 'cancel' | 'destructive' | 'default' }[]): Promise<number> {
    return new Promise((resolve, reject) => {
        Alert.alert(title, message, buttons.map((v, i) => ({ text: v.text, style: v.style, onPress: () => resolve(i) })));
    });
}

export function AlertProvider(props: { children: React.ReactNode }) {
    return props.children;
}
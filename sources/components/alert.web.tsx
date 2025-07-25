import { Pressable, Text, View } from 'react-native';
import { ModalProvider } from './modal';
import { Modal, ModalContextType, useModal } from './modal.web';
import { RoundButton } from '../components/RoundButton';
import { useTheme } from '@/theme';

export function useAlert() {
    const modal = useModal();
    return alert(modal);
}

function alert(modal: ModalContextType) {
    return async (title: string, message: string, buttons: { text: string, style?: 'cancel' | 'destructive' | 'default' }[]): Promise<number> => {
        return await new Promise<number>((resolve) =>
            modal.show((
                <Modal>
                    <AlertModal title={title} message={message} buttons={buttons} callback={resolve} />
                </Modal>
            ))
        );
    }

}

const AlertModal = (props: { title: string, message: string, buttons: { text: string, style?: 'cancel' | 'destructive' | 'default' }[], callback: (id: number) => void }) => {
    const modal = useModal();
    const theme = useTheme();
    const close = (id: number) => {
        modal.close();
        props.callback(id);
    }

    return (
        <View>
            <View style={{ flexDirection: 'row' }}>
                <Text style={{ color: theme.text, fontWeight: '600', flexGrow: 1 }} numberOfLines={1}>{props.title}</Text>
                <Pressable onPress={() => close(-1)} hitSlop={32}>
                    <Text style={{ color: theme.text, fontWeight: '600' }}>✕</Text>
                </Pressable>
            </View>
            <View style={{ width: 400, marginTop: 32, marginBottom: 32 }}>
                <Text style={{ color: theme.text }}>{props.message}</Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 32 }}>
                {props.buttons.map((v, i) => (
                    <RoundButton key={i} onPress={() => close(i)} title={v.text} size="normal" />
                ))}
            </View>
        </View>
    );
};

export function AlertProvider(props: { children: React.ReactNode }) {
    return (
        <ModalProvider>
            {props.children}
        </ModalProvider>
    )
}
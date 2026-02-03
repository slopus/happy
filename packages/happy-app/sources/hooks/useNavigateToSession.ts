import { useRouter } from "expo-router"

export function useNavigateToSession() {
    const router = useRouter();
    return (sessionId: string) => {
        router.navigate(`/session/${sessionId}`, {
            dangerouslySingular(name, params) {
                return 'session'
            },
        });
    }
}
import { useRouter } from "expo-router"

export function useNavigateToSession() {
    const router = useRouter();
    return (sessionId: string) => {
        router.navigate(`/session/${sessionId}`, {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            dangerouslySingular(_name, _params) {
                return 'session'
            },
        });
    }
}
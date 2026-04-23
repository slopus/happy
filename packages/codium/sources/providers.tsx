import { ReactNode } from 'react'
import { Provider as JotaiProvider } from 'jotai'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            refetchOnWindowFocus: false,
            retry: 1,
        },
    },
})

export function Providers({ children }: { children: ReactNode }) {
    return (
        <JotaiProvider>
            <QueryClientProvider client={queryClient}>
                {children}
            </QueryClientProvider>
        </JotaiProvider>
    )
}

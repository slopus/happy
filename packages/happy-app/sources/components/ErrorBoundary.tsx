import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface ErrorBoundaryProps {
    children: React.ReactNode;
    /** Fallback to render on error. If not provided, uses a default inline error message. */
    fallback?: (props: { error: Error; retry: () => void }) => React.ReactNode;
    /** Called when an error is caught */
    onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
    error: Error | null;
}

/**
 * Generic React error boundary. Catches render errors in children and shows a fallback.
 * Use `fallback` prop to customize the error UI for different contexts (session-level vs widget-level).
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error('[ErrorBoundary]', error, errorInfo);
        this.props.onError?.(error, errorInfo);
    }

    retry = () => {
        this.setState({ error: null });
    };

    render() {
        if (this.state.error) {
            if (this.props.fallback) {
                return this.props.fallback({ error: this.state.error, retry: this.retry });
            }
            return <InlineErrorFallback error={this.state.error} retry={this.retry} />;
        }
        return this.props.children;
    }
}

/** Small inline error indicator — used for widget-level failures (tool views, etc.) */
function InlineErrorFallback({ error, retry }: { error: Error; retry: () => void }) {
    return (
        <Pressable
            onPress={retry}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                padding: 12,
                gap: 8,
                opacity: 0.6,
            }}
        >
            <Ionicons name="alert-circle-outline" size={16} color="#FF3B30" />
            <Text style={{ fontSize: 13, color: '#FF3B30', flex: 1 }}>
                Failed to render. Tap to retry.
            </Text>
        </Pressable>
    );
}

import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, Platform } from 'react-native';
import { Stack } from 'expo-router';
import * as server from 'expo-http-server';
import * as Network from 'expo-network';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { StyleSheet } from 'react-native-unistyles';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    logContainer: {
        backgroundColor: theme.colors.surface,
        borderRadius: 8,
        padding: 12,
        marginHorizontal: 16,
        marginVertical: 8,
        maxHeight: 200,
    },
    logText: {
        fontFamily: 'Menlo',
        fontSize: 12,
        color: theme.colors.text,
        lineHeight: 18,
    },
    statusIndicator: {
        width: 12,
        height: 12,
        borderRadius: 6,
        marginRight: 8,
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
}));

export default function HttpServerDemo() {
    const [serverStatus, setServerStatus] = useState<'stopped' | 'running' | 'error'>('stopped');
    const [ipAddress, setIpAddress] = useState<string>('');
    const [requestLogs, setRequestLogs] = useState<string[]>([]);
    const [requestCount, setRequestCount] = useState(0);
    const port = 8080;

    const addLog = useCallback((message: string) => {
        const timestamp = new Date().toLocaleTimeString();
        setRequestLogs(prev => [`[${timestamp}] ${message}`, ...prev].slice(0, 50));
    }, []);

    const getDeviceIP = async () => {
        try {
            const ip = await Network.getIpAddressAsync();
            setIpAddress(ip);
            return ip;
        } catch (error) {
            console.error('Failed to get IP address:', error);
            setIpAddress('Unknown');
            return 'Unknown';
        }
    };

    const setupServer = useCallback(() => {
        server.setup(port, (event: server.StatusEvent) => {
            addLog(`Server status: ${event.status}`);
            
            if (event.status === 'ERROR') {
                setServerStatus('error');
                Modal.alert('Server Error', 'Failed to start HTTP server');
            } else if (event.status === 'STARTED') {
                setServerStatus('running');
                addLog(`Server running on port ${port}`);
            } else if (event.status === 'STOPPED') {
                setServerStatus('stopped');
                addLog('Server stopped');
            }
        });

        // Root endpoint - Hello World JSON
        server.route('/', 'GET', async (request) => {
            const count = requestCount + 1;
            setRequestCount(count);
            addLog(`GET / - Request #${count}`);
            console.log('Request received:', request);
            
            return {
                statusCode: 200,
                headers: {
                    'X-Server': 'expo-http-server',
                    'X-Platform': Platform.OS,
                },
                contentType: 'application/json',
                body: JSON.stringify({
                    message: 'Hello World!',
                    timestamp: new Date().toISOString(),
                    requestCount: count,
                    platform: Platform.OS,
                }),
            };
        });

        // HTML Hello World endpoint
        server.route('/hello', 'GET', async () => {
            const count = requestCount + 1;
            setRequestCount(count);
            addLog(`GET /hello - Request #${count}`);
            
            const html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Hello from Happy</title>
                    <style>
                        body {
                            font-family: -apple-system, system-ui, sans-serif;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            color: white;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100vh;
                            margin: 0;
                        }
                        .container {
                            text-align: center;
                            padding: 2rem;
                            background: rgba(255, 255, 255, 0.1);
                            border-radius: 20px;
                            backdrop-filter: blur(10px);
                        }
                        h1 {
                            font-size: 3rem;
                            margin: 0 0 1rem 0;
                        }
                        p {
                            font-size: 1.2rem;
                            opacity: 0.9;
                        }
                        .info {
                            margin-top: 2rem;
                            font-family: monospace;
                            background: rgba(0, 0, 0, 0.2);
                            padding: 1rem;
                            border-radius: 10px;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>🌍 Hello World!</h1>
                        <p>This is served from expo-http-server</p>
                        <div class="info">
                            <p>Platform: ${Platform.OS}</p>
                            <p>Request #${count}</p>
                            <p>Time: ${new Date().toLocaleString()}</p>
                        </div>
                    </div>
                </body>
                </html>`;
            
            return {
                statusCode: 200,
                contentType: 'text/html',
                body: html,
            };
        });

        // API test endpoint
        server.route('/api/test', 'GET', async (request) => {
            const count = requestCount + 1;
            setRequestCount(count);
            addLog(`GET /api/test - Request #${count}`);
            console.log('API test request:', request);
            
            return {
                statusCode: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 'success',
                    data: {
                        message: 'Test API endpoint',
                        timestamp: Date.now(),
                        platform: {
                            os: Platform.OS,
                            version: Platform.Version,
                        },
                    },
                }),
            };
        });

        // POST endpoint example
        server.route('/api/echo', 'POST', async (request) => {
            const count = requestCount + 1;
            setRequestCount(count);
            addLog(`POST /api/echo - Request #${count}`);
            
            return {
                statusCode: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    echo: request.body,
                    received: new Date().toISOString(),
                }),
            };
        });
    }, [requestCount, addLog]);

    useEffect(() => {
        getDeviceIP();
        setupServer();
        
        return () => {
            if (serverStatus === 'running') {
                server.stop();
            }
        };
    }, []);

    const handleStartServer = async () => {
        try {
            await getDeviceIP();
            server.start();
            setServerStatus('running');
            addLog('Starting server...');
        } catch (error) {
            console.error('Failed to start server:', error);
            Modal.alert('Error', 'Failed to start server');
        }
    };

    const handleStopServer = () => {
        server.stop();
        setServerStatus('stopped');
        addLog('Stopping server...');
    };

    const copyServerUrl = async () => {
        const url = `http://${ipAddress}:${port}`;
        await Clipboard.setStringAsync(url);
        Modal.alert('Copied!', `Server URL copied to clipboard:\n${url}`);
    };

    const getStatusColor = () => {
        switch (serverStatus) {
            case 'running':
                return '#34C759';
            case 'error':
                return '#FF3B30';
            default:
                return '#8E8E93';
        }
    };

    const serverUrl = `http://${ipAddress}:${port}`;

    return (
        <>
            <Stack.Screen
                options={{
                    title: 'HTTP Server',
                    headerLargeTitle: false,
                }}
            />
            <ItemList>
                <ItemGroup title="Server Status">
                    <Item
                        title="Status"
                        detail={serverStatus.charAt(0).toUpperCase() + serverStatus.slice(1)}
                        rightElement={
                            <View style={styles.statusContainer}>
                                <View style={[styles.statusIndicator, { backgroundColor: getStatusColor() }]} />
                            </View>
                        }
                        showChevron={false}
                    />
                    <Item
                        title="IP Address"
                        detail={ipAddress || 'Loading...'}
                        showChevron={false}
                    />
                    <Item
                        title="Port"
                        detail={String(port)}
                        showChevron={false}
                    />
                    <Item
                        title="Server URL"
                        subtitle={serverUrl}
                        icon={<Ionicons name="copy-outline" size={24} color="#007AFF" />}
                        onPress={copyServerUrl}
                    />
                    <Item
                        title="Request Count"
                        detail={String(requestCount)}
                        showChevron={false}
                    />
                </ItemGroup>

                <ItemGroup title="Controls">
                    {serverStatus !== 'running' ? (
                        <Item
                            title="Start Server"
                            icon={<Ionicons name="play-circle-outline" size={28} color="#34C759" />}
                            onPress={handleStartServer}
                        />
                    ) : (
                        <Item
                            title="Stop Server"
                            icon={<Ionicons name="stop-circle-outline" size={28} color="#FF3B30" />}
                            onPress={handleStopServer}
                        />
                    )}
                    <Item
                        title="Clear Logs"
                        icon={<Ionicons name="trash-outline" size={28} color="#FF9500" />}
                        onPress={() => {
                            setRequestLogs([]);
                            addLog('Logs cleared');
                        }}
                    />
                </ItemGroup>

                <ItemGroup title="Available Endpoints" footer="Test these endpoints using curl or a browser">
                    <Item
                        title="GET /"
                        subtitle="Returns Hello World JSON"
                        showChevron={false}
                    />
                    <Item
                        title="GET /hello"
                        subtitle="Returns HTML page with Hello World"
                        showChevron={false}
                    />
                    <Item
                        title="GET /api/test"
                        subtitle="Returns test API data with headers"
                        showChevron={false}
                    />
                    <Item
                        title="POST /api/echo"
                        subtitle="Echoes back the request body"
                        showChevron={false}
                    />
                </ItemGroup>

                {requestLogs.length > 0 && (
                    <ItemGroup title="Request Logs">
                        <View style={styles.logContainer}>
                            {requestLogs.map((log, index) => (
                                <Text key={index} style={styles.logText}>
                                    {log}
                                </Text>
                            ))}
                        </View>
                    </ItemGroup>
                )}
            </ItemList>
        </>
    );
}
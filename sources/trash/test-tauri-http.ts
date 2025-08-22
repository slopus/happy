/**
 * Test script to verify Tauri HTTP plugin is working with full web access
 * This should be run in the Tauri desktop app context
 */

// Import the Tauri HTTP plugin fetch function
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

export async function testTauriHttpAccess() {
    console.log('🧪 Testing Tauri HTTP access...');
    
    try {
        // Test HTTPS request to a public API
        console.log('Testing HTTPS request to httpbin.org...');
        const httpsResponse = await tauriFetch('https://httpbin.org/get');
        const httpsData = await httpsResponse.json();
        console.log('✅ HTTPS request successful:', httpsData);
        
        // Test HTTP request (if needed - most sites redirect to HTTPS)
        console.log('Testing HTTP request to httpbin.org...');
        const httpResponse = await tauriFetch('http://httpbin.org/get');
        const httpData = await httpResponse.json();
        console.log('✅ HTTP request successful:', httpData);
        
        // Test a different domain to verify full web access
        console.log('Testing request to jsonplaceholder API...');
        const apiResponse = await tauriFetch('https://jsonplaceholder.typicode.com/posts/1');
        const apiData = await apiResponse.json();
        console.log('✅ External API request successful:', apiData);
        
        return {
            success: true,
            message: 'All HTTP tests passed - full web access is enabled!',
            results: {
                https: httpsData,
                http: httpData,
                externalApi: apiData
            }
        };
        
    } catch (error) {
        console.error('❌ HTTP test failed:', error);
        return {
            success: false,
            message: 'HTTP test failed - check configuration',
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export async function testSpecificDomain(url: string) {
    console.log(`🧪 Testing access to specific URL: ${url}`);
    
    try {
        const response = await tauriFetch(url);
        const data = await response.text();
        console.log(`✅ Successfully accessed ${url}`);
        return {
            success: true,
            url,
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            data: data.substring(0, 200) + (data.length > 200 ? '...' : '')
        };
    } catch (error) {
        console.error(`❌ Failed to access ${url}:`, error);
        return {
            success: false,
            url,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

// Usage instructions:
// 1. Import this in your Tauri app: import { testTauriHttpAccess } from './test-tauri-http'
// 2. Call testTauriHttpAccess() to verify configuration
// 3. Call testSpecificDomain('https://your-api.com') to test specific URLs
// Test script to verify path selection logic
import { storage } from '../sync/storage';

// Mock function to test path selection
const getRecentPathForMachine = (machineId: string | null): string => {
    if (!machineId) return '~';
    
    const sessions = Object.values(storage.getState().sessions);
    const pathsWithTimestamps: Array<{ path: string; timestamp: number }> = [];
    const pathSet = new Set<string>();
    
    sessions.forEach(session => {
        if (session.metadata?.machineId === machineId && session.metadata?.path) {
            const path = session.metadata.path;
            if (!pathSet.has(path)) {
                pathSet.add(path);
                pathsWithTimestamps.push({
                    path,
                    timestamp: session.updatedAt || session.createdAt
                });
            }
        }
    });
    
    // Sort by most recent first
    pathsWithTimestamps.sort((a, b) => b.timestamp - a.timestamp);
    
    return pathsWithTimestamps[0]?.path || '~';
};

// Test scenarios
console.log('Testing path selection logic...\n');

// Test 1: No machine ID
console.log('Test 1 - No machine ID:');
console.log('Result:', getRecentPathForMachine(null));
console.log('Expected: ~\n');

// Test 2: Machine with no sessions
console.log('Test 2 - Machine with no sessions:');
console.log('Result:', getRecentPathForMachine('non-existent-machine'));
console.log('Expected: ~\n');

// Test 3: Get actual machine from state if exists
const machines = Object.values(storage.getState().machines);
if (machines.length > 0) {
    const testMachine = machines[0];
    console.log(`Test 3 - Machine "${testMachine.metadata?.displayName || testMachine.id}":`);
    const result = getRecentPathForMachine(testMachine.id);
    console.log('Result:', result);
    console.log('(Should return most recent path or ~ if no sessions)\n');
    
    // Show all paths for this machine
    const sessions = Object.values(storage.getState().sessions);
    const machinePaths = new Set<string>();
    sessions.forEach(session => {
        if (session.metadata?.machineId === testMachine.id && session.metadata?.path) {
            machinePaths.add(session.metadata.path);
        }
    });
    
    if (machinePaths.size > 0) {
        console.log('All paths for this machine:', Array.from(machinePaths));
    }
}

console.log('\nTest complete!');
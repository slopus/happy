#!/usr/bin/env node
/**
 * Detects host machine info and reports it to the server.
 * Run after `make seed` and `make cli` so the machine is registered.
 */
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const serverUrl = process.env.HAPPY_SERVER_URL || 'http://localhost:3005';
const happyHome = (process.env.HAPPY_HOME_DIR || '~/.happy').replace(/^~/, os.homedir());

function detectAgents() {
    const agents = [];
    const checks = [
        { name: 'claude', cmd: 'which claude' },
        { name: 'codex', cmd: 'which codex' },
        { name: 'gemini', cmd: 'which gemini' },
        { name: 'openclaw', cmd: 'which openclaw' },
    ];
    for (const { name, cmd } of checks) {
        try {
            execSync(cmd, { stdio: 'pipe' });
            agents.push(name);
        } catch {}
    }
    return agents;
}

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

async function main() {
    // Read token
    const keyFile = path.join(happyHome, 'access.key');
    if (!fs.existsSync(keyFile)) {
        console.error('Not authenticated. Run `make seed` first.');
        process.exit(1);
    }
    const { token } = JSON.parse(fs.readFileSync(keyFile, 'utf-8'));

    // Read machine ID from settings
    const settingsFile = path.join(happyHome, 'settings.json');
    if (!fs.existsSync(settingsFile)) {
        console.error('No settings.json found. Run `make seed` first.');
        process.exit(1);
    }
    const { machineId } = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    if (!machineId) {
        console.error('No machineId in settings.json.');
        process.exit(1);
    }

    // Read daemon control port if daemon is running
    let daemonPort = null;
    const daemonStateFile = path.join(happyHome, 'daemon.state.json');
    if (fs.existsSync(daemonStateFile)) {
        try {
            const state = JSON.parse(fs.readFileSync(daemonStateFile, 'utf-8'));
            daemonPort = state.httpPort || null;
        } catch {}
    }

    const workspaceRoot = process.env.HAPPY_WORKSPACE_ROOT
        ? process.env.HAPPY_WORKSPACE_ROOT.replace(/^~/, os.homedir())
        : null;

    const hostInfo = {
        hostname: os.hostname(),
        ip: getLocalIP(),
        platform: os.platform(),
        arch: os.arch(),
        agents: detectAgents(),
        daemonPort,
        workspaceRoot,
    };

    const displayName = os.hostname();

    console.log('Machine info:');
    console.log(`  ID:       ${machineId}`);
    console.log(`  Hostname: ${hostInfo.hostname}`);
    console.log(`  IP:       ${hostInfo.ip}`);
    console.log(`  Platform: ${hostInfo.platform}/${hostInfo.arch}`);
    console.log(`  Agents:   ${hostInfo.agents.length > 0 ? hostInfo.agents.join(', ') : 'none detected'}`);
    console.log(`  Workspace: ${workspaceRoot || '(not set)'}`);

    const res = await fetch(`${serverUrl}/v1/machines/${machineId}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ displayName, hostInfo }),
    });

    if (!res.ok) {
        console.error(`Failed to report: ${res.status} ${await res.text()}`);
        process.exit(1);
    }

    console.log('\nReported to server successfully.');
}

main().catch(e => { console.error(e); process.exit(1); });

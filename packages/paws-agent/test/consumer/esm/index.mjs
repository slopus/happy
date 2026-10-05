import { PawsAgentClient, PawsAgentError } from '@wangjs-jacky/paws-agent';

if (typeof PawsAgentClient !== 'function' || typeof PawsAgentError !== 'function') {
    throw new Error('ESM SDK exports are incomplete');
}

import { createAIServiceClient, createServiceController } from '@wangjs-jacky/paws-agent/services';
import { createNodePlatformTransport, createPlatformServiceHandler } from '@wangjs-jacky/paws-agent/services/node';
import { createBrowserPersonalTransport, createBrowserPlatformTransport, createBrowserServiceStorage } from '@wangjs-jacky/paws-agent/services/browser';
for (const entry of [createAIServiceClient, createServiceController, createNodePlatformTransport, createPlatformServiceHandler, createBrowserPersonalTransport, createBrowserPlatformTransport, createBrowserServiceStorage]) {
    if (typeof entry !== 'function') throw new Error('Shared AI service ESM entry is incomplete');
}

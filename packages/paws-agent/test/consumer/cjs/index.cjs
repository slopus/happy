const { PawsAgentClient, PawsAgentError } = require('@wangjs-jacky/paws-agent');

if (typeof PawsAgentClient !== 'function' || typeof PawsAgentError !== 'function') {
    throw new Error('CJS SDK exports are incomplete');
}

const serviceCore = require('@wangjs-jacky/paws-agent/services');
const serviceNode = require('@wangjs-jacky/paws-agent/services/node');
const serviceBrowser = require('@wangjs-jacky/paws-agent/services/browser');
for (const entry of [serviceCore.createAIServiceClient, serviceCore.createServiceController, serviceNode.createNodePlatformTransport, serviceNode.createPlatformServiceHandler, serviceBrowser.createBrowserPersonalTransport, serviceBrowser.createBrowserPlatformTransport, serviceBrowser.createBrowserServiceStorage]) {
    if (typeof entry !== 'function') throw new Error('Shared AI service CJS entry is incomplete');
}

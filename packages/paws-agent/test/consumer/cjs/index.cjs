const { PawsAgentClient, PawsAgentError } = require('@wangjs-jacky/paws-agent');

if (typeof PawsAgentClient !== 'function' || typeof PawsAgentError !== 'function') {
    throw new Error('CJS SDK exports are incomplete');
}

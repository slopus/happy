import { PawsAgentClient, PawsAgentError } from '@wangjs-jacky/paws-agent';

if (typeof PawsAgentClient !== 'function' || typeof PawsAgentError !== 'function') {
    throw new Error('ESM SDK exports are incomplete');
}

import { Command } from 'commander';
import { getRandomBytes } from '../api/encryption.js';
import { encodeBase64Url } from '../api/encryption.js';

export const generateKeyCommand = new Command('generate-key')
  .description('Generate a new secret key and print it to the command line')
  .action(() => {
    // Generate a new 32-byte secret key (256 bits)
    const secret = getRandomBytes(32);
    const keyBase64 = encodeBase64Url(secret);
    
    console.log('Generated new secret key:');
    console.log(keyBase64);
  }); 
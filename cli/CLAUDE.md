[this file is also linked to .cursorrules for claude code / cusror compatibility]

# What is claude code
Claude code is a command `claude` you run after installing through npm, in a directory of the proejct where you want to code.
It is agentic, and works similar to tools like cusror / vscode copilot agent modes, but it has not IDE backbone. It shows the diffs inline in terminal.

# We are building
So we are building a claude code session sharing.

## We have 3 components:
- handy-cli (this project)
- handy (react native client). Lives in `../handy`. This will be what people open on thier phones as an app or on the web.
- handy-server (nodejs server with prisma). Lives in the directory `../handy-server` from the root directory of this project. This will be running on our server with a known public url (https://handy-api.korshakov.org/, it is live). It will store sessions, and we will be connecting to it from both cli & the client. So 2 socket connections per session.



## Flow
- A user runs on their machine where they have claude code installed & authenticated, in a terminal directory of ther project XYZ. `handy-cli`
- We first need to authenticate with our server which lives on a known address, lets put this in a .env file
- First we need to generate a secret key - simply generate a random key and place it in the home directory as .handy-claude-code.key Just make it a small random sequence of base64 characaters, say 69 characters long
- Next we call /auth to get back auth token
- Finally we can create a new session with our server - we will do so using socket io for simplicity. See currently supported messages from the server package. Make sure to create strict types, ideally the same as on the server, note that these are server types we should import from a pacakge at a later point
- Once we have a session and got a socket connection going, we should spawn claude cli command and simply proxy each jsonline to the server through the socket.
- We will also be getting a message from the client thorugh the socket. Which will be simply { type: "text-input", content: string } for now. This is the only message type we will be capable of handling
- On subseqent messages we will spawn claude again, in the same way as before, but because we have an existing sesion with claude in this directory, we will pass the session id to it to continue where we left off. Claude keeps internal state based on this session id. Let me know if you can't find in the 


## Meta points

- Include high quality logs & comments in the header of each file explaining key resposibilities, and recording any critical decisions made during design for this.
- Keep initial commands intact for reference on how to use oclif
- Create a new command that will be run like `handy-cli start`
- Make sure to write unit tests when it makese sense. I do not want ANY mocking pretty much. In your tests actully call the server apis
- I despise untyped code - clean types, clean function signatures


## How auth will work (adopt to be runnable in node.js)

```ts
import * as Crypto from 'expo-crypto';
import * as TweetNacl from 'tweetnacl';

export function authChallenge(secret: Uint8Array) {
    const keypair = TweetNacl.sign.keyPair.fromSeed(secret);
    const challenge = Crypto.getRandomBytes(32);
    const signature = TweetNacl.sign.detached(challenge, keypair.secretKey);
    return { challenge, signature, publicKey: keypair.publicKey };
}



https://handy-api.korshakov.org/

/v1/auth

import { authChallenge } from "./authChallenge";
import axios from 'axios';
import { encodeBase64 } from "./base64";

export async function authGetToken(secret: Uint8Array) {
    const { challenge, signature, publicKey } = authChallenge(secret);
    const response = await axios.post('https://handy-api.korshakov.org/v1/auth', { challenge: encodeBase64(challenge), signature: encodeBase64(signature), publicKey: encodeBase64(publicKey) });
    const data = response.data;
    return data.token;
}
```

based on this idea I want to change how we execute our rapper around claude.

The behavior I want is the user will run our cli programm happy instead of running claude

Under the hood, we will first start the session, display the QR code (unless already shown before add new settings.json to ~/.handy/settings.json 
(we already use this path somewhere, save to settings if we have completed onboarding once we show the qr code once. 

If the system is macos - recomend them to install Amphetamine app to configure their computer to not go to sleep when they start a happy session

https://apps.apple.com/us/app/amphetamine/id937984704?mt=12

Also remind them they can Even close their laptop, completely with while running amphetamine and connect through hotspot to their phone to allow 
coding with their computer in their backpack on the go.

We should Mentioned that happy as an open source, end to end ecrypted wrapper around claude code, that allows you to start a regular claude terminal
session with `happy` command

Finally, when we have shown and the user has hit enter Button they will be dropped into a Claude session.
Continuing where I left off in my previous message, A pin point you can simply close your laptop, And continue your session on your native mobile
app that is authenticated and end to end encrypted with your mobile app trough a qr code.

The moment you connect From your phone to your happy session you Will seamlessly continue the conversation . As your return back To your computer, you can simply take over in the terminal again after pressing any key


your job is to implement This behavior, You must not overcomplicate things, You can see how minimal the current project set up is, We don't create too many files. We stick to a very minimalistic set up. It's a simple problem. It must be solved simply. 


Here's how we're going to do this:
we initially run the terminal assumed the on boarding is done, which you do have to implement from above. We simply show you the interactive terminal as if you're running Claude directly. At the same time, we are running the remote session and waiting for messages to be sent to us. 

Actually, before we can get the message sent to us, we would need to read the ~/.claude/projects/<project-name>/<session-id>.jsonl file, that was most recently touched. 

The way the project name is constructed - its simply the  absolute directory path with lashes replaced by dashes.
Example -Users-kirilldubovitskiy-projects-handy-cli

 so when  the user runs `happy` command, we will figure out the cwd, and read the ~/.claude/projects/<project-name>/<session-id>.jsonl file, that was most recently written to. 

 we need to start watching this file for updates, and When a new line is a pendant at the end, we will emit a message to the server like we currently do it here (in the loop.ts file)

 // Handle JSON output
if (output.type === 'json') {
    session.sendMessage({
        data: output.data,
        type: 'output',
    });
}

except we should make the type as 'output-passive-observer' and the data should be the entire line, same way we do it with output when its not passive.

Finally, now let's assume the user leaves their laptop and opens their mobile app where they will see the current session and will be able to send a message to it. We already have a mechanism to receive  this message right now, The moment we received a message, we will switch from interactive mode, To invoking the claude sdk every time we receive a message from the mobile app.

At this point, we want to Kill the process that was running the interactive session, and show a nice terminal UI that will Clearly showed that we are in HAPPY mode. And to exit you can press any key. Once the user presses, any key, we will re-start the interactive session again, but passing --resume flag to the sdk, with the most recent session we got back from the sdk's latest message.

Important caveat when we resume the session with --resume flag, claude actually will Actually create a new entry in our project with a new identifier, and upon receiving the first message will copy the Entire history from the previous session into this new session. Or at least this is what I observed on small conversations.

This introduces challenges:
- During the initial interactive mode, all messages will be in the same session, And have the same session identifier. 
- When we send anything from our mobile client and launch Claude Using the SDK with a resume flag and a --print flag, In the first response message that gets streamed, we will get a new session identifier. We will need to Always keep track of this most current session identifier in memory. We are already doing this in our loop implementation.
- Now once the customer hits and key, we will switch Back to an interactive session starting claude with --resume flag, and the most recent session identifier we have in memory.

keep in mind we Might want to go in and out of interactive mode multiple times. for the same happy session swigching betwwen termianl and mobile app controls.


Here is an interactive swicthing Between a child process, controlling the terminal and our process: resuse the same ideas.

// Auto-switching PTY experiment with screen buffer + resize trick
// Maintains full screen state and mouse functionality

const pty = require('node-pty');

// Get command from args or default to htop
const command = process.argv[2] || 'htop';
const args = process.argv.slice(3);

// Create PTY process
const childProcess = pty.spawn(command, args, {
  name: 'xterm-256color',
  cols: process.stdout.columns,
  rows: process.stdout.rows,
  cwd: process.cwd(),
  env: process.env
});

let showingChild = true;
let screenBuffer = '';

// Set up raw mode
process.stdin.setRawMode(true);
process.stdin.resume();

// Handle input
process.stdin.on('data', (data) => {
  // Ctrl+C to exit
  if (data.toString() === '\u0003') {
    cleanup();
    process.exit();
  }
  
  if (showingChild) {
    childProcess.write(data);
  } else {
    // In terminal mode, just echo the input
    process.stdout.write(data);
  }
});

// Handle child output
childProcess.onData((data) => {
  // Always accumulate in buffer
  screenBuffer += data;
  
  // Only display if currently showing child
  if (showingChild) {
    process.stdout.write(data);
  }
  
  // Keep buffer size reasonable (last ~100KB)
  if (screenBuffer.length > 100000) {
    screenBuffer = screenBuffer.slice(-50000);
  }
});

// Handle resize
process.on('SIGWINCH', () => {
  childProcess.resize(process.stdout.columns, process.stdout.rows);
});

// Clean exit
childProcess.onExit(() => {
  console.log(`\n${command} exited`);
  cleanup();
  process.exit();
});

function cleanup() {
  process.stdin.setRawMode(false);
  clearInterval(switchInterval);
}

function findLastCompleteScreen(buffer) {
  // Look for the last clear screen sequence
  const clearScreen = '\x1b[2J';
  let lastClearIndex = buffer.lastIndexOf(clearScreen);
  
  if (lastClearIndex === -1) {
    // No clear screen found, return entire buffer
    return buffer;
  }
  
  // Return everything from the last clear screen onward
  return buffer.slice(lastClearIndex);
}

function switchToChild() {
  showingChild = true;
  
  // Clear current screen
  process.stdout.write('\x1b[2J\x1b[H');
  
  // First replay the buffered screen content
  const lastScreen = findLastCompleteScreen(screenBuffer);
  if (lastScreen) {
    process.stdout.write(lastScreen);
  }
  
  // Then force a resize to trigger proper redraw and mouse state sync
  const cols = process.stdout.columns;
  const rows = process.stdout.rows;
  
  // Resize to smaller then back to original
  childProcess.resize(cols - 1, rows - 1);
  setTimeout(() => {
    childProcess.resize(cols, rows);
  }, 10);
  
  console.log(`\n=== ${command.toUpperCase()} SESSION (5 seconds) ===`);
}

function switchToTerminal() {
  showingChild = false;
  
  // Clear and reset screen
  process.stdout.write('\x1b[2J\x1b[H');
  
  console.log('=== TERMINAL MODE (5 seconds) ===');
  console.log('Type anything, it will echo here.');
  console.log(`${command} is still running in background!\n`);
  console.log('> ');
}

// Initial state
console.log(`Starting auto-switch demo with ${command} (Ctrl+C to exit)`);
console.log('Will switch between child process and terminal every 5 seconds\n');

// Start with terminal mode first
setTimeout(() => {
  switchToTerminal();
}, 1000);

// Auto-switch every 5 seconds
const switchInterval = setInterval(() => {
  if (showingChild) {
    switchToTerminal();
  } else {
    switchToChild();
  }
}, 5000);


first I want to read all of src/ to understand the codebase.
 Next, I want you to propose the exact sequence of implementation with sample code inline, of how youa are thinking of implementing this, Especially what's paying attention to any new files you might want to create, Your reflection Points on how the style of the Koch you are proposing matches the style of the project now. Do not actually make any changes without my approvals.

----

instead of placing settings into api, Reading a separate file for it, lets simply add a persistence folder where we will have the following functions

- readSettings
- writeSettings
- readPrivateKey
- writePrivateKey

 it will be fucking minimal no bullshit, NO fuckint capslock variable names.

 We don't need to keep track of last QR code shown.

Inateractive Claude session watcher
We don't need to fucking class for this shit!!! SIMPLE

watchMostRecentSession()

 because Claude code only creates an entry for the session the proejct's directory after the first message is sent, we need to start watching for basically a new Entry to appear in this directory. Because we are the one about to start a new session in this directory, We will assume it Once a new entry appears it was us who started it. This is the first portion of the watching, Once we have the identifier from the filename <session-id>.jsonl we will start watching for updates to this file.

So really this will be a multi step process 

It seems like for this to work we need to change how the loop is set up. 

We also need to handle the edge case of the interactive session never starting - What is the user simply runs happy, And immediately closes their laptop to start controlling the session through their phone?

 So it seems like we have to create the remote session immediately, without waiting for the interactive session to start. 


- start remote session
- start listening for new messages (current loop implemented)

- Start our Claude child process (fully interactive)
  - start watching for a new session to be created in the project directory (implemented as a single function, no need to create a class, no need to create multiple helpers)
  - when a new session is created, we will read the session identifier from the filename <session-id>.jsonl
    - We need to somehow communicate this to our loop, because it contains the session identifier we need to resume session from client. Lets think options.
  - we will start listening for updates to this file
  - when a new message is received, we will emit it to the server like we currently do it here (in the loop.ts file)
  - except we should make the type as 'output-passive-observer' and the data should be the entire line, same way we do it with output when its not passive.

- When a message from a remote client comes in
  - [later] Check if the terminal had any recent updates (means we are still in interactive mode and its actively doing something)
  - Kill our child Claude process & switch to remote-controlled mode
  - continue with existing loop implementation

- When there is any key input, while we are in remote-controlled mode
  -  this means the user is back at their laptop and we want to switch back to interactive mode
  -  we will start a new child Claude process with the most recent session identifier we have in memory. And this restarts the loop essentially.


So now our loops will have 2 modes. What we must maintain is to clearly show all key control flow in this sinble location. NO BULLSHIT.

We clearly hate EventEmitter - DO Not use.

Also all variables must be explicitly passed to functions. Functional style is always preferred.


--------

I don't like callbacks if async await can be used - it is always preffered.
 I do not like unnecessary state.

We can pass in an abort controller to the watcher function, and use fs/promises watcher api to pass the abort controller into it.

 For example in your watcher - I do not want to keep track of watchers.
  Once we have detected a new session was created - we should stop the folder watcher, and start a watcher for this file.

 I want the whole watcher function to be an AsyncGenerator, which will yield new messages as they com into that file. 

lastPositions - hate it - we will have a single file, so lets keep a single variable, local to where it is used.

InteractiveSession - name it InteractiveChildClaude


Make sure when we are starting this interactive Claude we are not touching the other claude 

Not switchToRemote - probably more like requestSwitchToRemote
We might want to check for if the terminal is still doing stuff - in that case we should let it stabilize & only after switch (mark as TODO: Do not implement yet, hold off) in a comment.

Lets also use fs/promises insted of fs apis.

Importatly this loop is now broken - you deleted the old logic where the loop wakes up on a new message. 
// Process remote messages
      while (!exiting) {
        if (mode === 'remote' && messageQueue.length > 0) {
          const message = messageQueue.shift();
          if (message) {
            await processRemoteMessage(message);
          }
        }

        // Small delay to prevent busy loop
        await new Promise(resolve => setTimeout(resolve, 100));
      }
We should indefinitely hang while our process is not killed. See original implementation for this.


-----

// Wait for watcher to finish (only finishes when the watcher is aborted)
// either because we switched to remote mode or because the whole process is killed.
await watcherPromise;


----

For later
We need to implement thinking when the interactive teriminal is busy 



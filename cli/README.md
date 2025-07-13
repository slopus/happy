# handy-cli

CLI tool for connecting Claude Code sessions to the handy server for remote access.

[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)


<!-- toc -->
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->

## Overview

handy-cli bridges Claude Code sessions with the handy server, allowing remote access to Claude Code from mobile/web clients. It authenticates with the server, establishes a WebSocket connection, and proxies messages between Claude CLI and connected clients.

## Installation

```bash
npm install
npm run build
```

## Configuration

Create a `.env` file with:

```
HANDY_SERVER_URL=https://handy-api.korshakov.org
HANDY_SOCKET_PATH=/v1/updates
```

# Usage
<!-- usage -->
```sh-session
$ npm install -g handy-cli
$ handy-cli COMMAND
running command...
$ handy-cli (--version)
handy-cli/0.0.0 darwin-arm64 node-v22.17.0
$ handy-cli --help [COMMAND]
USAGE
  $ handy-cli COMMAND
...
```
<!-- usagestop -->
# Commands
<!-- commands -->
- [handy-cli](#handy-cli)
  - [Overview](#overview)
  - [Installation](#installation)
  - [Configuration](#configuration)
- [Usage](#usage)
- [Commands](#commands)
  - [`handy-cli hello PERSON`](#handy-cli-hello-person)
  - [`handy-cli hello world`](#handy-cli-hello-world)
  - [`handy-cli help [COMMAND]`](#handy-cli-help-command)
  - [`handy-cli plugins`](#handy-cli-plugins)
  - [`handy-cli plugins add PLUGIN`](#handy-cli-plugins-add-plugin)
  - [`handy-cli plugins:inspect PLUGIN...`](#handy-cli-pluginsinspect-plugin)
  - [`handy-cli plugins install PLUGIN`](#handy-cli-plugins-install-plugin)
  - [`handy-cli plugins link PATH`](#handy-cli-plugins-link-path)
  - [`handy-cli plugins remove [PLUGIN]`](#handy-cli-plugins-remove-plugin)
  - [`handy-cli plugins reset`](#handy-cli-plugins-reset)
  - [`handy-cli plugins uninstall [PLUGIN]`](#handy-cli-plugins-uninstall-plugin)
  - [`handy-cli plugins unlink [PLUGIN]`](#handy-cli-plugins-unlink-plugin)
  - [`handy-cli plugins update`](#handy-cli-plugins-update)
  - [Architecture](#architecture)
  - [Project Structure](#project-structure)
  - [Current Status](#current-status)
  - [Development](#development)
  - [Key Design Decisions](#key-design-decisions)

## `handy-cli hello PERSON`

Say hello

```
USAGE
  $ handy-cli hello PERSON -f <value>

ARGUMENTS
  PERSON  Person to say hello to

FLAGS
  -f, --from=<value>  (required) Who is saying hello

DESCRIPTION
  Say hello

EXAMPLES
  $ handy-cli hello friend --from oclif
  hello friend from oclif! (./src/commands/hello/index.ts)
```

_See code: [src/commands/hello/index.ts](https://github.com/bra1ndump/handy-cli/blob/v0.0.0/src/commands/hello/index.ts)_

## `handy-cli hello world`

Say hello world

```
USAGE
  $ handy-cli hello world

DESCRIPTION
  Say hello world

EXAMPLES
  $ handy-cli hello world
  hello world! (./src/commands/hello/world.ts)
```

_See code: [src/commands/hello/world.ts](https://github.com/bra1ndump/handy-cli/blob/v0.0.0/src/commands/hello/world.ts)_

## `handy-cli help [COMMAND]`

Display help for handy-cli.

```
USAGE
  $ handy-cli help [COMMAND...] [-n]

ARGUMENTS
  COMMAND...  Command to show help for.

FLAGS
  -n, --nested-commands  Include all nested commands in the output.

DESCRIPTION
  Display help for handy-cli.
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/v6.2.30/src/commands/help.ts)_

## `handy-cli plugins`

List installed plugins.

```
USAGE
  $ handy-cli plugins [--json] [--core]

FLAGS
  --core  Show core plugins.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List installed plugins.

EXAMPLES
  $ handy-cli plugins
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.44/src/commands/plugins/index.ts)_

## `handy-cli plugins add PLUGIN`

Installs a plugin into handy-cli.

```
USAGE
  $ handy-cli plugins add PLUGIN... [--json] [-f] [-h] [-s | -v]

ARGUMENTS
  PLUGIN...  Plugin to install.

FLAGS
  -f, --force    Force npm to fetch remote resources even if a local copy exists on disk.
  -h, --help     Show CLI help.
  -s, --silent   Silences npm output.
  -v, --verbose  Show verbose npm output.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Installs a plugin into handy-cli.

  Uses npm to install plugins.

  Installation of a user-installed plugin will override a core plugin.

  Use the HANDY_CLI_NPM_LOG_LEVEL environment variable to set the npm loglevel.
  Use the HANDY_CLI_NPM_REGISTRY environment variable to set the npm registry.

ALIASES
  $ handy-cli plugins add

EXAMPLES
  Install a plugin from npm registry.

    $ handy-cli plugins add myplugin

  Install a plugin from a github url.

    $ handy-cli plugins add https://github.com/someuser/someplugin

  Install a plugin from a github slug.

    $ handy-cli plugins add someuser/someplugin
```

## `handy-cli plugins:inspect PLUGIN...`

Displays installation properties of a plugin.

```
USAGE
  $ handy-cli plugins inspect PLUGIN...

ARGUMENTS
  PLUGIN...  [default: .] Plugin to inspect.

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Displays installation properties of a plugin.

EXAMPLES
  $ handy-cli plugins inspect myplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.44/src/commands/plugins/inspect.ts)_

## `handy-cli plugins install PLUGIN`

Installs a plugin into handy-cli.

```
USAGE
  $ handy-cli plugins install PLUGIN... [--json] [-f] [-h] [-s | -v]

ARGUMENTS
  PLUGIN...  Plugin to install.

FLAGS
  -f, --force    Force npm to fetch remote resources even if a local copy exists on disk.
  -h, --help     Show CLI help.
  -s, --silent   Silences npm output.
  -v, --verbose  Show verbose npm output.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Installs a plugin into handy-cli.

  Uses npm to install plugins.

  Installation of a user-installed plugin will override a core plugin.

  Use the HANDY_CLI_NPM_LOG_LEVEL environment variable to set the npm loglevel.
  Use the HANDY_CLI_NPM_REGISTRY environment variable to set the npm registry.

ALIASES
  $ handy-cli plugins add

EXAMPLES
  Install a plugin from npm registry.

    $ handy-cli plugins install myplugin

  Install a plugin from a github url.

    $ handy-cli plugins install https://github.com/someuser/someplugin

  Install a plugin from a github slug.

    $ handy-cli plugins install someuser/someplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.44/src/commands/plugins/install.ts)_

## `handy-cli plugins link PATH`

Links a plugin into the CLI for development.

```
USAGE
  $ handy-cli plugins link PATH [-h] [--install] [-v]

ARGUMENTS
  PATH  [default: .] path to plugin

FLAGS
  -h, --help          Show CLI help.
  -v, --verbose
      --[no-]install  Install dependencies after linking the plugin.

DESCRIPTION
  Links a plugin into the CLI for development.

  Installation of a linked plugin will override a user-installed or core plugin.

  e.g. If you have a user-installed or core plugin that has a 'hello' command, installing a linked plugin with a 'hello'
  command will override the user-installed or core plugin implementation. This is useful for development work.


EXAMPLES
  $ handy-cli plugins link myplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.44/src/commands/plugins/link.ts)_

## `handy-cli plugins remove [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ handy-cli plugins remove [PLUGIN...] [-h] [-v]

ARGUMENTS
  PLUGIN...  plugin to uninstall

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Removes a plugin from the CLI.

ALIASES
  $ handy-cli plugins unlink
  $ handy-cli plugins remove

EXAMPLES
  $ handy-cli plugins remove myplugin
```

## `handy-cli plugins reset`

Remove all user-installed and linked plugins.

```
USAGE
  $ handy-cli plugins reset [--hard] [--reinstall]

FLAGS
  --hard       Delete node_modules and package manager related files in addition to uninstalling plugins.
  --reinstall  Reinstall all plugins after uninstalling.
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.44/src/commands/plugins/reset.ts)_

## `handy-cli plugins uninstall [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ handy-cli plugins uninstall [PLUGIN...] [-h] [-v]

ARGUMENTS
  PLUGIN...  plugin to uninstall

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Removes a plugin from the CLI.

ALIASES
  $ handy-cli plugins unlink
  $ handy-cli plugins remove

EXAMPLES
  $ handy-cli plugins uninstall myplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.44/src/commands/plugins/uninstall.ts)_

## `handy-cli plugins unlink [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ handy-cli plugins unlink [PLUGIN...] [-h] [-v]

ARGUMENTS
  PLUGIN...  plugin to uninstall

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Removes a plugin from the CLI.

ALIASES
  $ handy-cli plugins unlink
  $ handy-cli plugins remove

EXAMPLES
  $ handy-cli plugins unlink myplugin
```

## `handy-cli plugins update`

Update installed plugins.

```
USAGE
  $ handy-cli plugins update [-h] [-v]

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Update installed plugins.
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.44/src/commands/plugins/update.ts)_
<!-- commandsstop -->

## Architecture

- **Authentication**: Uses tweetnacl for public key authentication with the handy server
- **Socket Communication**: Socket.IO client for real-time bidirectional messaging  
- **Claude Integration**: Spawns Claude CLI with `--output-format stream-json` for structured output
- **Message Handling**: Routes messages between socket server and Claude process

## Project Structure

```
src/
├── auth/          # Authentication modules (key generation, auth flow)
├── socket/        # Socket.IO client and message types
├── claude/        # Claude CLI spawning and session management
├── handlers/      # Message routing between socket and Claude
├── utils/         # Utilities (config, logger, paths)
└── commands/      # CLI commands (start)
```

## Current Status

- ✅ Authentication with handy server works
- ✅ Claude CLI process spawning implemented  
- ✅ Message routing architecture complete
- ❌ WebSocket connection fails (server returns 502 error)

## Development

Run tests:

```bash
npm test
```

Build:

```bash
npm run build
```

Run locally:

```bash
./bin/run.js start
```

## Key Design Decisions

1. **No mocking in tests** - All tests use real server APIs as requested
2. **Strong typing** - Full TypeScript with strict types for all messages
3. **Session persistence** - Claude session IDs tracked for resumption
4. **Event-driven architecture** - Loose coupling between components
5. **Graceful shutdown** - Proper cleanup on SIGINT/SIGTERM

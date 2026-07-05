# kiro-cli local help

## kiro-cli --help
```text

kiro-cli (Kiro CLI)

Popular Subcommands              Usage: kiro-cli [subcommand]
╭────────────────────────────────────────────────────╮
│ chat         Chat with Kiro CLI                    │
│ agent        Manage AI agents                      │
│ doctor       Debug installation issues             │ 
│ settings     Customize appearance & behavior       │
│ quit         Quit the app                          │
╰────────────────────────────────────────────────────╯

Use --agent AGENT_NAME to start chat with a specific agent

To see all subcommands, use:
 ❯ kiro-cli --help-all
ㅤ
```

## kiro-cli --help-all
```text

USAGE:
    kiro-cli [OPTIONS] [SUBCOMMAND]

Commands:
  debug         Debug the app
  settings      Customize appearance & behavior
  setup         Setup cli components
  update        Update the Kiro application
  diagnostic    Run diagnostic tests
  init          Generate the dotfiles for the given shell
  theme         Get or set theme
  issue         Create a new Github issue
  login         Login
  logout        Logout
  whoami        Prints details about the current user
  profile       Show the profile associated with this idc user
  user          Manage your account
  doctor        Fix and diagnose common issues
  launch        Launch the desktop app
  quit          Quit the desktop app
  restart       Restart the desktop app
  integrations  Manage system integrations
  translate     Natural Language to Shell translation
  dashboard     Open the dashboard
  chat          AI assistant in your terminal
  mcp           Model Context Protocol (MCP)
  inline        Inline shell completions
  agent         Agent root commands
  acp           Agent Client Protocol (ACP)
  help          Print this message or the help of the given subcommand(s)

Options:
  -v, --verbose...
          Increase logging verbosity

      --help-all
          Print help for all subcommands

      --agent <AGENT>
          Launch chat with specified agent

      --tui
          Launch chat in TUI mode

      --classic
          Launch chat in classic (legacy) UI mode

      --v3
          Launch the next generation Kiro agent

  -r, --resume
          Resume the most recent conversation from this directory

      --resume-id <SESSION_ID>
          Resume a specific conversation by session ID

      --resume-picker
          Interactively select a conversation to resume from this directory
          
          [aliases: --list]

  -h, --help
          Print help

  -V, --version
          Print version
```

## kiro-cli acp --help
```text
Start Agent Client Protocol (ACP) agent

Usage: kiro-cli-chat acp [OPTIONS]

Options:
      --agent <AGENT>             Name of the agent to use when starting the first session
      --model <MODEL>             Model ID to use when starting the first session
      --effort <EFFORT>           Initial effort level (e.g. low, medium, high, xhigh, max)
  -a, --trust-all-tools           Auto-approve all tool permission requests
      --trust-tools <TOOL_NAMES>  Trust only this set of tools
      --agent-engine <ENGINE>     Agent engine to use: "v1", "v2" (default), or "v3" [default: v2]
                                  [possible values: v2, v1, v3]
  -v, --verbose...                Increase logging verbosity
  -h, --help                      Print help
```

## kiro-cli --version
```text
kiro-cli 2.11.0
```

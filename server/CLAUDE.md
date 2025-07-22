# Handy Server - Development Guidelines

This document contains the development guidelines and instructions for the Happy Server project. This guide OVERRIDES any default behaviors and MUST be followed exactly.

## Project Overview

**Name**: happy-server  
**Repository**: https://github.com/slopus/happy-server.git  
**License**: MIT  
**Language**: TypeScript  
**Runtime**: Node.js 20  
**Framework**: Fastify with opinionated architecture  

## Core Technology Stack

- **Runtime**: Node.js 20
- **Language**: TypeScript (strict mode enabled)
- **Web Framework**: Fastify 5
- **Database**: PostgreSQL with Prisma ORM
- **Validation**: Zod
- **HTTP Client**: Axios
- **Real-time**: Socket.io
- **Cache/Pub-Sub**: Redis (via ioredis)
- **Testing**: Vitest
- **Package Manager**: Yarn (not npm)

## Development Environment

### Commands
- `yarn build` - TypeScript type checking
- `yarn start` - Start the server
- `yarn test` - Run tests
- `yarn migrate` - Run Prisma migrations
- `yarn generate` - Generate Prisma client
- `yarn db` - Start local PostgreSQL in Docker

### Environment Requirements
- FFmpeg installed (for media processing)
- Python3 installed
- PostgreSQL database
- Redis (for event bus and caching)

## Code Style and Structure

### General Principles
- Use 4 spaces for tabs (not 2 spaces)
- Write concise, technical TypeScript code with accurate examples
- Use functional and declarative programming patterns; avoid classes
- Prefer iteration and modularization over code duplication
- Use descriptive variable names with auxiliary verbs (e.g., isLoading, hasError)
- All sources must be imported using "@/" prefix (e.g., `import "@/utils/log"`)
- Always use absolute imports
- Prefer interfaces over types
- Avoid enums; use maps instead
- Use strict mode in TypeScript for better type safety

### Folder Structure
```
/sources                    # Root of the sources
├── /app                   # Application entry points
│   ├── api.ts            # API server setup
│   └── timeout.ts        # Timeout handling
├── /apps                  # Applications directory
│   └── /api              # API server application
│       └── /routes       # API routes
├── /modules              # Reusable modules (non-application logic)
├── /utils                # Low level or abstract utilities
├── /recipes              # Scripts to run outside of the server
├── /services             # Core services
│   └── pubsub.ts        # Pub/sub service
├── /storage              # Database and storage utilities
│   ├── db.ts            # Database client
│   ├── inTx.ts          # Transaction wrapper
│   ├── repeatKey.ts     # Key utilities
│   ├── simpleCache.ts   # Caching utility
│   └── types.ts         # Storage types
└── main.ts               # Main entry point
```

### Naming Conventions
- Use lowercase with dashes for directories (e.g., components/auth-wizard)
- When writing utility functions, always name file and function the same way
- Test files should have ".spec.ts" suffix

## Tool Usage

### Web Search and Fetching
- When in doubt, use web tool to get answers from the web
- Search web when you have some failures

### File Operations
- NEVER create files unless they're absolutely necessary
- ALWAYS prefer editing existing files to creating new ones
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested

## Utilities

### Writing Utility Functions
1. Always name file and function the same way for easy discovery
2. Utility functions should be modular and not too complex
3. Always write tests for utility functions BEFORE writing the code
4. Iterate implementation and tests until the function works as expected
5. Always write documentation for utility functions

## Modules

### Module Guidelines
- Modules are bigger than utility functions and abstract away complexity
- Each module should have a dedicated directory
- Modules usually don't have application-specific logic
- Modules can depend on other modules, but not on application-specific logic
- Prefer to write code as modules instead of application-specific code

### When to Use Modules
- When integrating with external services
- When abstracting complexity of some library
- When implementing related groups of functions (math, date, etc.)

### Known Modules
- **ai**: AI wrappers to interact with AI services
- **eventbus**: Event bus to send and receive events between modules and applications
- **lock**: Simple lock to synchronize access to resources in the whole cluster
- **media**: Tools to work with media files

## Applications

- Applications contain application-specific logic
- Applications have the most complexity; other parts should assist by reducing complexity
- When using prompts, write them to "_prompts.ts" file relative to the application

## Database

### Prisma Usage
- Prisma is used as ORM
- Use "inTx" to wrap database operations in transactions
- Do not update schema without absolute necessity
- For complex fields, use "Json" type

### Current Schema Status
The project has pending Prisma migrations that need to be applied:
- Migration: `20250715012822_add_metadata_version_agent_state`

## Events

### Event Bus
- eventbus allows sending and receiving events inside the process and between different processes
- eventbus is local or redis based
- Use "afterTx" to send events after transaction is committed successfully instead of directly emitting events

## Testing

- Write tests using Vitest
- Test files should be named the same as source files with ".spec.ts" suffix
- For utility functions, write tests BEFORE implementation

## API Development

- API server is in `/sources/apps/api`
- Routes are in `/sources/apps/api/routes`
- Use Fastify with Zod for type-safe route definitions
- Always validate inputs using Zod

## Docker Deployment

The project includes a multi-stage Dockerfile:
1. Builder stage: Installs dependencies and builds the application
2. Runner stage: Minimal runtime with only necessary files
3. Exposes port 3000
4. Requires FFmpeg and Python3 in the runtime

## Important Reminders

1. Do what has been asked; nothing more, nothing less
2. NEVER create files unless they're absolutely necessary for achieving your goal
3. ALWAYS prefer editing an existing file to creating a new one
4. NEVER proactively create documentation files (*.md) or README files unless explicitly requested
5. Use 4 spaces for tabs (not 2 spaces)
6. Use yarn instead of npm for all package management
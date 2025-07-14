/**
 * Simple MCP Permission Server
 * 
 * Starts an HTTP server that acts as an MCP server for intercepting
 * tool permission requests from Claude.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { logger } from '@/ui/logger'

export interface PermissionRequest {
  id: string
  tool: string
  arguments: any
  timestamp: number
}

export interface PermissionResponse {
  id: string
  approved: boolean
  reason?: string
}

export interface PermissionServer {
  port: number
  url: string
  toolName: string
  stop: () => Promise<void>
  respondToPermission: (response: PermissionResponse) => void
}

/**
 * Start a permission MCP server
 * @param onPermissionRequest - Callback when a permission request is received
 * @returns Server control object
 */
export async function startPermissionServer(
  onPermissionRequest: (request: PermissionRequest) => void
): Promise<PermissionServer> {
  const pendingRequests = new Map<string, {
    resolve: (response: any) => void
    reject: (error: Error) => void
  }>()
  
  let lastRequestInput: any = {}
  let server: ReturnType<typeof createServer>
  let port: number = 0;
  
  // Handle incoming HTTP requests
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }
    
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }
    
    // Read request body
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', async () => {
      try {
        const request = JSON.parse(body)
        logger.info('[MCP] Request:', request.method, request.params?.name || '')
        
        // Handle different request types
        if (request.method === 'tools/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              tools: [
                {
                  name: 'request_permission',
                  description: 'Request permission to execute a tool',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      tool: {
                        type: 'string',
                        description: 'The tool that needs permission',
                      },
                      arguments: {
                        type: 'object',
                        description: 'The arguments for the tool',
                      },
                    },
                    required: ['tool', 'arguments'],
                  },
                },
              ],
            },
          }))
        } else if (request.method === 'tools/call' && request.params?.name === 'request_permission') {
          // Handle permission request
          logger.info(`[MCP] Full request params:`, JSON.stringify(request.params, null, 2))
          
          // Check if arguments exist and have the expected structure
          const args = request.params.arguments || {}
          // Claude sends: { tool_name, input, tool_use_id }
          const { tool_name, input, tool_use_id } = args
          
          // Store the input for the response
          lastRequestInput = input || {}
          
          const permissionRequest: PermissionRequest = {
            id: Math.random().toString(36).substring(7),
            tool: tool_name || 'unknown',
            arguments: input || {},
            timestamp: Date.now(),
          }
          
          logger.info(`[MCP] Permission request for tool: ${tool_name}`, input)
          logger.info(`[MCP] Tool use ID: ${tool_use_id}`)
          
          // Call the callback
          onPermissionRequest(permissionRequest)
          
          // Wait for response
          const response = await waitForPermissionResponse(permissionRequest.id)
          
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: response,
          }))
        } else if (request.method === 'initialize') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: {},
              },
              serverInfo: {
                name: 'permission-server',
                version: '1.0.0',
              },
            },
          }))
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32601,
              message: 'Method not found',
            },
          }))
        }
      } catch (error) {
        logger.error('[MCP] Request error:', error)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal error',
          },
        }))
      }
    })
  }
  
  // Wait for permission response
  const waitForPermissionResponse = (id: string): Promise<any> => {
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject })
    })
  }
  
  // Start the server
  logger.info('[MCP] Starting HTTP permission server...')
  
  await new Promise<void>((resolve, reject) => {
    // Create HTTP server
    server = createServer(handleRequest)
    
    // Listen on random port
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address !== 'string') {
        port = address.port
        logger.info(`[MCP] HTTP server started on port ${port}`)
        resolve()
      } else {
        reject(new Error('Failed to get server port'))
      }
    })
    
    server.on('error', (error) => {
      logger.error('[MCP] Server error:', error)
      reject(error)
    })
  })
  
  // Return control object
  return {
    port,
    url: `http://localhost:${port}`,
    toolName: 'mcp__permission-server__request_permission',
    
    async stop() {
      logger.info('[MCP] Stopping HTTP server...')
      
      return new Promise<void>((resolve) => {
        server.close(() => {
          logger.info('[MCP] HTTP server stopped')
          resolve()
        })
      })
    },
    
    respondToPermission(response: PermissionResponse) {
      const pending = pendingRequests.get(response.id)
      if (pending) {
        pendingRequests.delete(response.id)
        // Claude expects a JSON string that can be parsed as either:
        // { behavior: "allow", updatedInput: {...} } or { behavior: "deny", message: "..." }
        const result = response.approved
          ? { behavior: 'allow', updatedInput: lastRequestInput || {} }
          : { behavior: 'deny', message: response.reason || 'Permission denied by user' }
        
        pending.resolve({
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
          isError: false, // Always false - Claude will parse the JSON to determine error state
        })
        logger.info(`[MCP] Permission response for ${response.id}: ${response.approved}`)
      } else {
        logger.warn(`[MCP] No pending request found for ${response.id}`)
      }
    }
  }
}
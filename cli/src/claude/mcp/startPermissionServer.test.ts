/**
 * Test MCP Permission Server Function
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { startPermissionServer, PermissionRequest, PermissionServer } from './startPermissionServer'
import axios from 'axios'

describe('startPermissionServer', () => {
  let permissionServer: PermissionServer
  const permissionRequests: PermissionRequest[] = []
  
  beforeAll(async () => {
    // Start MCP server with callback
    permissionServer = await startPermissionServer((request) => {
      console.log('Permission request received:', request)
      permissionRequests.push(request)
      
      // Auto-approve for testing with a small delay to avoid race condition
      setTimeout(() => {
        permissionServer.respondToPermission({
          id: request.id,
          approved: true,
          reason: 'Auto-approved for testing',
        })
      }, 10)
    })
  })
  
  afterAll(async () => {
    // Stop MCP server
    await permissionServer.stop()
  })
  
  test('should handle MCP protocol requests', async () => {
    const serverUrl = permissionServer.url
    
    // Test initialize
    const initResponse = await axios.post(serverUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    })
    
    expect(initResponse.data.result).toHaveProperty('protocolVersion')
    expect(initResponse.data.result.serverInfo.name).toBe('permission-server')
    
    // Test tools/list
    const toolsResponse = await axios.post(serverUrl, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    })
    
    expect(toolsResponse.data.result.tools).toHaveLength(1)
    expect(toolsResponse.data.result.tools[0].name).toBe('request_permission')
  })
  
  test('should handle permission tool calls', async () => {
    // Clear previous requests
    permissionRequests.length = 0
    
    // Get server URL
    const serverUrl = permissionServer.url
    
    // Test direct permission request (using Claude's format)
    const response = await axios.post(serverUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'request_permission',
        arguments: {
          tool_name: 'LS',  // Claude uses tool_name, not tool
          input: { path: '/tmp' },  // Claude uses input, not arguments
          tool_use_id: 'test_123'
        }
      }
    })
    
    expect(response.data.result).toHaveProperty('content')
    expect(response.data.result.isError).toBe(false)
    expect(permissionRequests).toHaveLength(1)
    expect(permissionRequests[0].tool).toBe('LS')
    expect(permissionRequests[0].arguments).toEqual({ path: '/tmp' })
    
    // Verify the response content
    const content = JSON.parse(response.data.result.content[0].text)
    expect(content.behavior).toBe('allow')
    expect(content.updatedInput).toEqual({ path: '/tmp' })
  })
  
  test('should provide correct tool name', () => {
    expect(permissionServer.toolName).toBe('mcp__permission-server__request_permission')
  })
  
  test('should handle permission denial', async () => {
    // Clear previous requests
    permissionRequests.length = 0
    
    // Start a new server that denies requests
    const denyServer = await startPermissionServer((request) => {
      permissionRequests.push(request)
      
      // Deny request
      setTimeout(() => {
        denyServer.respondToPermission({
          id: request.id,
          approved: false,
          reason: 'Test denial',
        })
      }, 10)
    })
    
    try {
      const serverUrl = denyServer.url
      
      // Test permission denial
      const response = await axios.post(serverUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'request_permission',
          arguments: {
            tool_name: 'Write',
            input: { file_path: '/etc/passwd', content: 'hack' },
            tool_use_id: 'test_456'
          }
        }
      })
      
      expect(response.data.result).toHaveProperty('content')
      expect(response.data.result.isError).toBe(false)
      
      // Verify the denial response
      const content = JSON.parse(response.data.result.content[0].text)
      expect(content.behavior).toBe('deny')
      expect(content.message).toBe('Test denial')
    } finally {
      await denyServer.stop()
    }
  })
})
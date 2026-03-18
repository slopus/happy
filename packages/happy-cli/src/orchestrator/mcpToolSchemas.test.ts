import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ORCHESTRATOR_SUBMIT_TOOL_SCHEMA } from './mcpToolSchemas';

describe('orchestrator mcp tool schemas', () => {
  it('accepts target.type machine alias in submit schema', () => {
    const submitSchema = z.object(ORCHESTRATOR_SUBMIT_TOOL_SCHEMA.inputSchema);
    const parsed = submitSchema.parse({
      title: 'alias test',
      tasks: [
        {
          provider: 'codex',
          model: 'gpt-5.3-codex-medium',
          prompt: 'hello',
          target: {
            type: 'machine',
            machineId: 'machine-1',
          },
        },
      ],
    });

    expect(parsed.tasks[0].target?.type).toBe('machine_id');
  });

  it('adds guidance descriptions for high-risk fields', () => {
    const submitSchema = ORCHESTRATOR_SUBMIT_TOOL_SCHEMA.inputSchema;
    const taskSchema = submitSchema.tasks.element;
    const targetSchema = taskSchema.shape.target.unwrap();

    expect(taskSchema.shape.provider.description).toContain('provider');
    expect(taskSchema.shape.model.description).toContain('modelModes[provider]');
    expect(taskSchema.shape.model.description).toContain('"default"');
    expect(targetSchema.shape.type.description).toContain('Alias "machine" is accepted');
    expect(submitSchema.mode.description).toContain('"blocking"');
    expect(submitSchema.controllerSessionId.description).toContain('Defaults to current MCP session');
  });
});

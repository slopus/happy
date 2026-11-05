import { describe, expect, it } from 'vitest';
import { NewMachineUpdateContainerSchema } from './messages';

describe('new-machine wire contract', () => {
  const update = {
    id: 'update', seq: 1, createdAt: 100,
    body: {
      t: 'new-machine', machineId: 'machine', seq: 0,
      metadata: 'encrypted', metadataVersion: 1,
      daemonState: null, daemonStateVersion: 0,
      dataEncryptionKey: 'key', active: false, activeAt: 0,
      createdAt: 100, updatedAt: 100,
    },
  };

  it('retains the data key and machine metadata', () => {
    expect(NewMachineUpdateContainerSchema.parse(update)).toEqual(update);
  });

  it('accepts keyless legacy machines but rejects incomplete events', () => {
    expect(NewMachineUpdateContainerSchema.safeParse({ ...update, body: { ...update.body, dataEncryptionKey: null } }).success).toBe(true);
    expect(NewMachineUpdateContainerSchema.safeParse({ ...update, body: { ...update.body, metadataVersion: undefined } }).success).toBe(false);
  });
});
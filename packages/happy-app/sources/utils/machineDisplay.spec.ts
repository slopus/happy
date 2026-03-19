import { describe, it, expect } from 'vitest';
import { getMachineDisplayName, type MinimalSession, type MinimalMachine } from './machineDisplay';

describe('machineDisplay', () => {
    describe('getMachineDisplayName', () => {
        const baseSession: MinimalSession = {
            metadata: {
                host: 'lute.example.com',
                machineId: 'machine-1'
            }
        };

        const baseMachine: MinimalMachine = {
            metadata: {
                host: 'lute.example.com'
            }
        };

        describe('priority 1: Machine displayName', () => {
            it('should use machine displayName when available', () => {
                const machine: MinimalMachine = {
                    metadata: {
                        host: 'lute.example.com',
                        displayName: 'My MacBook Pro'
                    }
                };
                expect(getMachineDisplayName(baseSession, machine)).toBe('My MacBook Pro');
            });

            it('should prioritize displayName over hostname', () => {
                const machine: MinimalMachine = {
                    metadata: {
                        host: 'lute.example.com',
                        displayName: 'Dev Server'
                    }
                };
                expect(getMachineDisplayName(baseSession, machine)).toBe('Dev Server');
            });
        });

        describe('priority 2: Machine short hostname', () => {
            it('should use short hostname from machine metadata', () => {
                const machine: MinimalMachine = {
                    metadata: {
                        host: 'lute.example.com'
                    }
                };
                expect(getMachineDisplayName(baseSession, machine)).toBe('lute');
            });

            it('should return full hostname if no dots', () => {
                const machine: MinimalMachine = {
                    metadata: {
                        host: 'localhost'
                    }
                };
                expect(getMachineDisplayName(baseSession, machine)).toBe('localhost');
            });

            it('should handle hostname with multiple dots', () => {
                const machine: MinimalMachine = {
                    metadata: {
                        host: 'web01.prod.example.com'
                    }
                };
                expect(getMachineDisplayName(baseSession, machine)).toBe('web01');
            });
        });

        describe('priority 3: Session metadata host fallback', () => {
            it('should fall back to session metadata host when machine is null', () => {
                expect(getMachineDisplayName(baseSession, null)).toBe('lute');
            });

            it('should fall back to session metadata host when machine is undefined', () => {
                expect(getMachineDisplayName(baseSession, undefined)).toBe('lute');
            });

            it('should fall back when machine metadata is null', () => {
                const machine: MinimalMachine = {
                    metadata: null
                };
                expect(getMachineDisplayName(baseSession, machine)).toBe('lute');
            });

            it('should extract short hostname from FQDN in session', () => {
                const session: MinimalSession = {
                    metadata: {
                        host: 'server.internal.company.com',
                        machineId: 'machine-1'
                    }
                };
                expect(getMachineDisplayName(session, null)).toBe('server');
            });
        });

        describe('edge cases', () => {
            it('should return undefined when no hostname available', () => {
                const session: MinimalSession = {
                    metadata: null
                };
                expect(getMachineDisplayName(session, null)).toBeUndefined();
            });

            it('should return undefined when session metadata has empty host', () => {
                const session: MinimalSession = {
                    metadata: {
                        host: '',
                        machineId: 'machine-1'
                    }
                };
                expect(getMachineDisplayName(session, null)).toBeUndefined();
            });

            it('should handle empty displayName by falling back', () => {
                const machine: MinimalMachine = {
                    metadata: {
                        host: 'lute.example.com',
                        displayName: ''
                    }
                };
                // Empty string is falsy, should fall back to hostname
                expect(getMachineDisplayName(baseSession, machine)).toBe('lute');
            });
        });

        describe('common scenarios', () => {
            it('should work for localhost', () => {
                const session: MinimalSession = {
                    metadata: {
                        host: 'localhost'
                    }
                };
                expect(getMachineDisplayName(session, null)).toBe('localhost');
            });

            it('should work for remote server with FQDN', () => {
                const session: MinimalSession = {
                    metadata: {
                        host: 'prod-server-01.us-west-2.company.com'
                    }
                };
                expect(getMachineDisplayName(session, null)).toBe('prod-server-01');
            });

            it('should work with custom machine names', () => {
                const machine: MinimalMachine = {
                    metadata: {
                        host: 'macbook.local',
                        displayName: "Jon's MacBook Pro"
                    }
                };
                expect(getMachineDisplayName(baseSession, machine)).toBe("Jon's MacBook Pro");
            });
        });

        describe('integration examples', () => {
            it('should combine with path for complete subtitle', () => {
                const session: MinimalSession = {
                    metadata: {
                        host: 'lute.example.com',
                        machineId: 'machine-1'
                    }
                };
                const path = '~/projects/myapp';
                const hostname = getMachineDisplayName(session, null);

                expect(hostname).toBe('lute');
                expect(`${hostname}:${path}`).toBe('lute:~/projects/myapp');
            });

            it('should work with custom display name in subtitle', () => {
                const session: MinimalSession = {
                    metadata: {
                        host: 'macbook.local',
                        machineId: 'machine-1'
                    }
                };
                const machine: MinimalMachine = {
                    metadata: {
                        host: 'macbook.local',
                        displayName: 'My MacBook'
                    }
                };
                const path = '~/Code/happy';
                const hostname = getMachineDisplayName(session, machine);

                expect(hostname).toBe('My MacBook');
                expect(`${hostname}:${path}`).toBe('My MacBook:~/Code/happy');
            });
        });
    });
});

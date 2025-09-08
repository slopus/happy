interface TestResult {
    name: string;
    passed: boolean;
    error?: Error;
    duration: number;
}

interface TestSuite {
    name: string;
    tests: TestResult[];
}

class TestRunner {
    private suites: Map<string, TestSuite> = new Map();
    private currentSuite: string | null = null;
    private currentTests: Array<{ name: string; fn: () => void | Promise<void> }> = [];

    describe(name: string, fn: () => void) {
        this.currentSuite = name;
        this.currentTests = [];
        
        // Execute the describe block to collect tests
        fn();
        
        // Store the collected tests
        this.suites.set(name, {
            name,
            tests: []
        });
        
        // Store test functions for later execution
        const suite = this.suites.get(name)!;
        suite.tests = this.currentTests.map(test => ({
            name: test.name,
            passed: false,
            duration: 0
        }));
        
        // Store the test functions separately for execution
        (suite as any).testFunctions = this.currentTests;
        
        this.currentSuite = null;
    }

    it(name: string, fn: () => void | Promise<void>) {
        if (!this.currentSuite) {
            throw new Error('it() must be called inside describe()');
        }
        
        this.currentTests.push({ name, fn });
    }

    async runAll(): Promise<TestSuite[]> {
        const results: TestSuite[] = [];
        
        for (const [suiteName, suite] of this.suites) {
            const testFunctions = (suite as any).testFunctions as Array<{ name: string; fn: () => void | Promise<void> }>;
            const suiteResult: TestSuite = {
                name: suiteName,
                tests: []
            };
            
            for (let i = 0; i < testFunctions.length; i++) {
                const test = testFunctions[i];
                const startTime = Date.now();
                
                try {
                    await test.fn();
                    suiteResult.tests.push({
                        name: test.name,
                        passed: true,
                        duration: Date.now() - startTime
                    });
                } catch (error) {
                    suiteResult.tests.push({
                        name: test.name,
                        passed: false,
                        error: error as Error,
                        duration: Date.now() - startTime
                    });
                }
            }
            
            results.push(suiteResult);
        }
        
        return results;
    }

    async runSuite(suiteName: string): Promise<TestSuite | null> {
        const suite = this.suites.get(suiteName);
        if (!suite) return null;
        
        const testFunctions = (suite as any).testFunctions as Array<{ name: string; fn: () => void | Promise<void> }>;
        const suiteResult: TestSuite = {
            name: suiteName,
            tests: []
        };
        
        for (const test of testFunctions) {
            const startTime = Date.now();
            
            try {
                await test.fn();
                suiteResult.tests.push({
                    name: test.name,
                    passed: true,
                    duration: Date.now() - startTime
                });
            } catch (error) {
                suiteResult.tests.push({
                    name: test.name,
                    passed: false,
                    error: error as Error,
                    duration: Date.now() - startTime
                });
            }
        }
        
        return suiteResult;
    }

    getSuites(): string[] {
        return Array.from(this.suites.keys());
    }

    clear() {
        this.suites.clear();
        this.currentSuite = null;
        this.currentTests = [];
    }
}

// Simple expect implementation
class Expect<T> {
    private negated = false;

    constructor(private actual: T) {}

    get not(): Expect<T> {
        const newExpect = new Expect(this.actual);
        newExpect.negated = true;
        return newExpect;
    }

    toEqual(expected: T) {
        const isEqual = this.deepEqual(this.actual, expected);
        
        if (this.negated) {
            if (isEqual) {
                throw new Error(`Expected ${JSON.stringify(expected)} to not equal ${JSON.stringify(this.actual)}`);
            }
        } else {
            if (!isEqual) {
                throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(this.actual)}`);
            }
        }
    }

    toBe(expected: T) {
        const isEqual = this.actual === expected;
        
        if (this.negated) {
            if (isEqual) {
                throw new Error(`Expected ${expected} to not be ${this.actual}`);
            }
        } else {
            if (!isEqual) {
                throw new Error(`Expected ${expected} but got ${this.actual}`);
            }
        }
    }

    toBeTruthy() {
        if (this.negated) {
            if (this.actual) {
                throw new Error(`Expected falsy value but got ${this.actual}`);
            }
        } else {
            if (!this.actual) {
                throw new Error(`Expected truthy value but got ${this.actual}`);
            }
        }
    }

    toBeFalsy() {
        if (this.negated) {
            if (!this.actual) {
                throw new Error(`Expected truthy value but got ${this.actual}`);
            }
        } else {
            if (this.actual) {
                throw new Error(`Expected falsy value but got ${this.actual}`);
            }
        }
    }

    toBeGreaterThan(expected: number) {
        const actualNum = this.actual as unknown as number;
        if (this.negated) {
            if (actualNum > expected) {
                throw new Error(`Expected ${actualNum} to not be greater than ${expected}`);
            }
        } else {
            if (!(actualNum > expected)) {
                throw new Error(`Expected ${actualNum} to be greater than ${expected}`);
            }
        }
    }

    toThrow(message?: string) {
        if (typeof this.actual !== 'function') {
            throw new Error('toThrow can only be used with functions');
        }
        
        let didThrow = false;
        let thrownError: any;
        
        try {
            (this.actual as any)();
        } catch (error: any) {
            didThrow = true;
            thrownError = error;
        }
        
        if (this.negated) {
            if (didThrow) {
                throw new Error('Expected function to not throw but it did');
            }
        } else {
            if (!didThrow) {
                throw new Error('Expected function to throw but it did not');
            }
            if (message && thrownError && !thrownError.message.includes(message)) {
                throw new Error(`Expected error message to include "${message}" but got "${thrownError.message}"`);
            }
        }
    }

    private deepEqual(a: any, b: any): boolean {
        if (a === b) return true;
        
        if (a instanceof Uint8Array && b instanceof Uint8Array) {
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) {
                if (a[i] !== b[i]) return false;
            }
            return true;
        }
        
        if (a && b && typeof a === 'object' && typeof b === 'object') {
            const keysA = Object.keys(a);
            const keysB = Object.keys(b);
            
            if (keysA.length !== keysB.length) return false;
            
            for (const key of keysA) {
                if (!keysB.includes(key)) return false;
                if (!this.deepEqual(a[key], b[key])) return false;
            }
            
            return true;
        }
        
        return false;
    }
}

// Global test runner instance
export const testRunner = new TestRunner();

// Export test functions
export const describe = (name: string, fn: () => void) => testRunner.describe(name, fn);
export const it = (name: string, fn: () => void | Promise<void>) => testRunner.it(name, fn);
export const expect = <T>(actual: T) => new Expect(actual);

export type { TestResult, TestSuite };
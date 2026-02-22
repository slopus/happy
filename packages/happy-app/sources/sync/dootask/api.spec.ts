import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dootaskLogin, dootaskGetTokenExpire, dootaskFetchTasks } from './api';

describe('dootask api', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        global.fetch = vi.fn();
    });
    afterEach(() => { vi.restoreAllMocks(); });

    const serverUrl = 'https://dootask.example.com';
    const token = 'test-token-123';

    describe('dootaskLogin', () => {
        it('should return profile on success (ret=1)', async () => {
            (global.fetch as any).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    ret: 1, msg: 'ok',
                    data: { userid: 42, email: 'a@b.com', nickname: 'Test', userimg: 'https://img', token: 'new-token' }
                })
            });
            const result = await dootaskLogin({ serverUrl, email: 'a@b.com', password: 'pass' });
            expect(result.type).toBe('success');
            if (result.type === 'success') {
                expect(result.token).toBe('new-token');
                expect(result.userId).toBe(42);
            }
        });

        it('should return captcha_required when data.code=need', async () => {
            (global.fetch as any).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    ret: 0, msg: 'Captcha required',
                    data: { code: 'need', code_key: 'abc123' }
                })
            });
            const result = await dootaskLogin({ serverUrl, email: 'a@b.com', password: 'pass' });
            expect(result.type).toBe('captcha_required');
            if (result.type === 'captcha_required') {
                expect(result.codeKey).toBe('abc123');
            }
        });

        it('should return error on ret!=1 without captcha', async () => {
            (global.fetch as any).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ ret: 0, msg: 'Invalid password', data: {} })
            });
            const result = await dootaskLogin({ serverUrl, email: 'a@b.com', password: 'wrong' });
            expect(result.type).toBe('error');
        });

        it('should use POST method', async () => {
            (global.fetch as any).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ ret: 1, msg: 'ok', data: { userid: 1, email: '', nickname: '', userimg: '', token: 't' } })
            });
            await dootaskLogin({ serverUrl, email: 'a@b.com', password: 'pass' });
            expect(global.fetch).toHaveBeenCalledWith(
                `${serverUrl}/api/users/login`,
                expect.objectContaining({ method: 'POST' })
            );
        });
    });

    describe('dootaskGetTokenExpire', () => {
        it('should return expiration info on success', async () => {
            (global.fetch as any).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    ret: 1, msg: 'ok',
                    data: { expired_at: '2026-03-01T00:00:00Z', remaining_seconds: 86400 }
                })
            });
            const result = await dootaskGetTokenExpire(serverUrl, token);
            expect(result.ret).toBe(1);
        });
    });

    describe('dootaskFetchTasks', () => {
        it('should pass filters as query params', async () => {
            (global.fetch as any).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    ret: 1, msg: 'ok',
                    data: { data: [], current_page: 1, last_page: 1, total: 0 }
                })
            });
            await dootaskFetchTasks(serverUrl, token, { page: 1, pagesize: 20, project_id: 5 });
            const url = (global.fetch as any).mock.calls[0][0] as string;
            expect(url).toContain('project_id=5');
            expect(url).toContain('page=1');
        });

        it('should pass with_extend as query param', async () => {
            (global.fetch as any).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    ret: 1, msg: 'ok',
                    data: { data: [], current_page: 1, last_page: 1, total: 0 }
                })
            });
            await dootaskFetchTasks(serverUrl, token, { page: 1, pagesize: 20, with_extend: 'project_name,column_name' });
            const url = (global.fetch as any).mock.calls[0][0] as string;
            expect(url).toContain('with_extend=project_name%2Ccolumn_name');
        });
    });

    describe('token expiry detection', () => {
        it('should detect token expired from ret=-1', async () => {
            (global.fetch as any).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ ret: -1, msg: '请登录后继续', data: {} })
            });
            const result = await dootaskFetchTasks(serverUrl, token, { page: 1, pagesize: 20 });
            expect(result.ret).toBe(-1);
        });
    });
});

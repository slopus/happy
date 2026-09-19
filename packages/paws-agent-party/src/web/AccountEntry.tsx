import { useEffect, useState } from 'react';
import { GroupChatApp } from './GroupChatApp.js';

import { AccountContext } from './AccountContext.js';
const SESSION_KEY = 'party-account-session';
const ORIGIN = 'https://47.115.228.20:8443';
export function AccountEntry() {
  const [session, setSession] = useState<{ token: string; accountId: string; serverUrl: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [legacy, setLegacy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const fragment = new URLSearchParams(location.hash.slice(1));
    const ticket = fragment.get('ticket');
    if (ticket) history.replaceState(null, '', location.pathname + location.search);
    const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
    void (async () => {
      const configuration = await fetch(`${base}/api/access/config`, { signal: controller.signal });
      if (configuration.status === 401 || configuration.status === 404) { setLegacy(true); return; }
      if (!configuration.ok) throw Error('暂时无法打开群聊，请稍后重试。');
      let token = sessionStorage.getItem(SESSION_KEY);
      if (ticket) {
        // A new login replaces any previous tab session; never fall back to it.
        sessionStorage.removeItem(SESSION_KEY);
        if (token) void fetch(`${base}/api/access/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, keepalive: true }).catch(() => undefined);
        const response = await fetch(`${base}/api/access/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }), signal: controller.signal });
        if (!response.ok) throw Error('连接已过期，请重新登录 Paws。');
        token = (await response.json()).token;
      }
      if (!token) return;
      const accountResponse = await fetch(`${base}/api/access/account`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
      if (!accountResponse.ok) throw Error('账号连接已失效，请重新登录。');
      const account = await accountResponse.json();
      if (!controller.signal.aborted) {
        sessionStorage.setItem(SESSION_KEY, token);
        setSession({ token, accountId: account.account.id, serverUrl: account.serverUrl });
      }
    })().catch(error => { if (!controller.signal.aborted) { sessionStorage.removeItem(SESSION_KEY); setError(error.message); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  const logout = () => {
    if (session) void fetch(`${(import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')}/api/access/logout`, { method: 'POST', headers: { authorization: `Bearer ${session.token}` }, keepalive: true }).catch(() => undefined);
    sessionStorage.removeItem(SESSION_KEY); setSession(null);
  };
  if (legacy) return <GroupChatApp/>;
  if (session) return <AccountContext.Provider value={{ ...session, logout, expired: () => { logout(); setError('登录已失效，请重新登录。'); } }}><GroupChatApp key={session.token}/></AccountContext.Provider>;
  return <main className="account-welcome"><section><span className="account-eyebrow">PAWS · AGENT PARTY</span><h1>把不同的想法，<br/>放进同一个群聊。</h1><p>在 Paws 配置 Agent，登录后邀请它们一起讨论、读图与协作。<br/>群聊和图片只属于你的账号，电脑与手机保持同步。</p>{error && <p role="alert">{error}</p>}{loading ? <p role="status">正在连接你的空间…</p> : <a className="account-login" href={`${ORIGIN}/agent-party-access`}>使用 Paws 继续 →</a>}<small>已有账号直接登录；新用户可在 Paws 免费创建账号，无需邀请码。</small></section><aside aria-hidden="true"><span>一个问题，多种视角</span><h2>提问 · 讨论 · 一起完成</h2><p>你的 Agent 工作台</p></aside></main>;
}

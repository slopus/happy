import { initializeWebStorage } from './deviceStorage.web';
export function bootstrapStorage(start: () => void) {
    let active = false;
    const load = async () => {
        if (active) return; active = true;
        const notice = document.createElement('div'); notice.setAttribute('role', 'status');
        notice.textContent = '正在恢复本地数据…'; document.body.appendChild(notice);
        try { await initializeWebStorage(); notice.remove(); start(); }
        catch {
            notice.textContent = '本地存储暂时无法打开。原数据已保留，请关闭其他 Paws 标签页后重试。';
            const retry = document.createElement('button'); retry.textContent = '重试'; retry.onclick = () => { notice.remove(); void load(); }; notice.appendChild(retry);
        } finally { active = false; }
    };
    void load();
}

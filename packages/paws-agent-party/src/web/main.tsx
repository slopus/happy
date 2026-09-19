import { createRoot } from 'react-dom/client';
import { GroupChatApp } from './GroupChatApp.js';
import { AdminApp } from './AdminApp.js';
import './styles.css';
try { document.documentElement.className = localStorage.getItem('ap-theme') === 'dark' ? 'dark' : 'light'; } catch { document.documentElement.className = 'light'; }
createRoot(document.getElementById('root')!).render(window.location.pathname.replace(/\/$/, '').endsWith('/admin') ? <AdminApp /> : <GroupChatApp />);

import { createRoot } from 'react-dom/client';
import { AccountEntry } from './AccountEntry.js';
import { AdminApp } from './AdminApp.js';
import './styles.css';
try { document.documentElement.className = localStorage.getItem('ap-theme') === 'dark' ? 'dark' : 'light'; } catch { document.documentElement.className = 'light'; }
const path = window.location.pathname.replace(/\/$/, '');
createRoot(document.getElementById('root')!).render(path.endsWith('/admin') ? <AdminApp /> : <AccountEntry />);

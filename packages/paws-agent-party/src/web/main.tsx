import { createRoot } from 'react-dom/client';
import { AccountEntry } from './AccountEntry.js';
import './styles.css';
try { document.documentElement.className = localStorage.getItem('ap-theme') === 'dark' ? 'dark' : 'light'; } catch { document.documentElement.className = 'light'; }
createRoot(document.getElementById('root')!).render(<AccountEntry />);

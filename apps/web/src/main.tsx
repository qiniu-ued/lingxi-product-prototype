import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { SetupPage } from './SetupPage.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(
  <StrictMode>{window.location.pathname === '/setup' ? <SetupPage /> : <App />}</StrictMode>,
);

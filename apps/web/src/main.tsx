import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeApp } from './RuntimeApp.js';
import './styles.css';
import './desktop.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(
  <StrictMode>
    <RuntimeApp />
  </StrictMode>,
);

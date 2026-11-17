import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/global.css';
import { createQueryClient } from '@/api/queryClient';
import { App } from '@/app/App';
import { createAppRouter } from '@/app/router';

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element in index.html');

createRoot(container).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
);

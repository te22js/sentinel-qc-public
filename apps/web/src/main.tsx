import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';
import { Shell } from './shell';
import { QCPage } from './pages/QC';
import { HistoryPage } from './pages/History';
import { MonitoringPage } from './pages/Monitoring';
import { PlatesPage } from './pages/Plates';
import { GuidePage } from './pages/Guide';
import { PlateDetailPage } from './pages/PlateDetail';

const rootRoute = createRootRoute({ component: Shell });

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: QCPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/history', component: HistoryPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/monitoring', component: MonitoringPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/plates', component: PlatesPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/plates/$plateId', component: PlateDetailPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/guide', component: GuidePage }),
];

const routeTree = rootRoute.addChildren(routes);
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);

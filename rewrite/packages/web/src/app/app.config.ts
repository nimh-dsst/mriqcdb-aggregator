import {
  ApplicationConfig,
  importProvidersFrom,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import {
  provideRouter,
  withEnabledBlockingInitialNavigation,
  withInMemoryScrolling,
} from '@angular/router';
import { provideNativeDateAdapter } from '@angular/material/core';
import {
  ArrowLeftRight,
  Pencil, ChartColumn, ChartSpline, ChartNoAxesCombined, ChartCandlestick, Table2,
  Grid2x2, ChartScatter, Hexagon, Shapes, ChartColumnStacked, ChartLine, ChartArea, PanelsTopLeft,
  Download,
  Maximize2,
  Minimize2,
  Grip,
  GripVertical,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Info,
  Link,
  LucideAngularModule,
  Plus,
  Sun,
  SunMoon,
  Moon,
  SlidersHorizontal,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-angular';
import { API } from './api/api';
import { MockApi } from './api/mock-api';
import { TrpcApi } from './api/trpc-api';
import { useMockApi } from '../environments/environment';

export const APP_ROUTES = [
  { path: 'about', loadComponent: () => import('./about/about').then((m) => m.About) },
  { path: '', loadComponent: () => import('./dashboard/dashboard').then(m => m.Dashboard) },
  { path: '**', redirectTo: '' },
];

export const WEB_ICONS = LucideAngularModule.pick({
  ArrowLeftRight,
  Pencil, ChartColumn, ChartSpline, ChartNoAxesCombined, ChartCandlestick, Table2,
  Grid2x2, ChartScatter, Hexagon, Shapes, ChartColumnStacked, ChartLine, ChartArea, PanelsTopLeft,
  Download,
  Maximize2,
  Minimize2,
  Grip,
  GripVertical,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Info,
  Link,
  Plus,
  Sun,
  SunMoon,
  Moon,
  SlidersHorizontal,
  TriangleAlert,
  Upload,
  X,
});

/**
 * The application's only composition root.
 *
 * Both `Api` implementations are listed; `useMockApi()` picks one -- the build
 * default, overridable per browser with `?mock=1`. The router hosts the
 * dashboard and its About page; analytical state travels in the shared `s`
 * query parameter across both routes.
 *
 * The initial navigation blocks bootstrap: the dashboard's whole state is in
 * that query parameter, so the graph has to be built against a resolved URL
 * rather than against the empty one the router starts with.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideNativeDateAdapter(),
    importProvidersFrom(WEB_ICONS),
    provideRouter(
      APP_ROUTES,
      withInMemoryScrolling({ anchorScrolling: 'enabled', scrollPositionRestoration: 'enabled' }),
      withEnabledBlockingInitialNavigation(),
    ),
    MockApi,
    TrpcApi,
    { provide: API, useExisting: useMockApi() ? MockApi : TrpcApi },
  ],
};

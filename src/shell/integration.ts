import type { CanvasApiClient } from '@augmentd-labs/canvas-api-client';
import type { ComponentType } from 'react';
import type { DesktopStore } from './store';
import type { DesktopState, Layout, Scope } from './model';

// Components own their view and styles. Only this contract crosses folders;
// neither menu placement nor the native host is part of a widget's data model.
export type DesktopServices = {
  client: CanvasApiClient;
  store: DesktopStore;
  state: DesktopState;
  scope?: Scope;
  layout?: Layout;
  account: string;
  native: boolean;
  report: (error: unknown) => void;
  settings: () => void;
  mounts: () => void;
  logout: () => void;
  tile: () => void;
};
export type DesktopWidget = { id: string; title: string; component: ComponentType<DesktopServices> };

import type { DesktopApi } from '@lingxi/protocol';

declare global {
  interface Window {
    lingxiDesktop?: DesktopApi;
  }
}

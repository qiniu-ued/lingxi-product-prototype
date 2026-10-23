import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('lingxiDesktop', {
  action: (input: unknown) => ipcRenderer.invoke('desktop.action', input),
  snapshot: () => ipcRenderer.invoke('desktop.snapshot'),
  pick: (input: unknown) => ipcRenderer.invoke('desktop.pick', input),
  info: () => ipcRenderer.invoke('desktop.info'),
  bounds: (value: unknown) => ipcRenderer.send('desktop.bounds', value),
});

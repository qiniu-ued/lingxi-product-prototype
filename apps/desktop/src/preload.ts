import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('lingxiDesktop', {
  action: (input: unknown) => ipcRenderer.invoke('desktop.action', input),
  snapshot: () => ipcRenderer.invoke('desktop.snapshot'),
  pick: (input: unknown) => ipcRenderer.invoke('desktop.pick', input),
  info: () => ipcRenderer.invoke('desktop.info'),
  microphone: () => ipcRenderer.invoke('desktop.microphone'),
  copy: (text: string) => ipcRenderer.invoke('desktop.copy', text),
  audioFrame: (pcm: ArrayBuffer) => ipcRenderer.send('voice.frame', pcm),
  onAudio: (listener: (value: unknown) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
    ipcRenderer.on('voice.audio', receive);
    return () => ipcRenderer.off('voice.audio', receive);
  },
  bounds: (value: unknown) => ipcRenderer.send('desktop.bounds', value),
});

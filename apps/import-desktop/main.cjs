const { app, BrowserWindow, session, Menu, screen } = require('electron');
app.setName('Alyte Import Lab');
if (process.env.ALYTE_DESKTOP_PROFILE) app.setPath('userData', process.env.ALYTE_DESKTOP_PROFILE);
const origin = 'http://127.0.0.1:4317';
app.whenReady().then(async () => {
  const localSession = session.fromPartition('alyte-import-session');
  localSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  localSession.setPermissionCheckHandler(() => false);
  localSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed =
      details.url.startsWith(origin + '/') ||
      details.url.startsWith('blob:' + origin + '/') ||
      details.url.startsWith('chrome-extension:') ||
      details.url.startsWith('chrome:') ||
      details.url.startsWith('data:') ||
      details.url === 'about:blank';
    callback({ cancel: !allowed });
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Alyte Import Lab',
        submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const window = new BrowserWindow({
    width: Math.min(1440, width),
    height: Math.min(920, height),
    minWidth: 640,
    minHeight: 500,
    title: 'Alyte Import Lab',
    backgroundColor: '#f5f4ef',
    webPreferences: {
      session: localSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      plugins: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== origin + '/') event.preventDefault();
  });
  await window.loadURL(origin);
});
app.on('window-all-closed', () => app.quit());

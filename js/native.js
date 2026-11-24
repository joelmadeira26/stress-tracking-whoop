// Android app bridge (Capacitor). The same web app runs in Chrome and inside the Pulse app;
// inside the app it uses native Bluetooth and a foreground service so recording continues
// with the screen off.

export function isNativeApp() {
  try {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  } catch {
    return false;
  }
}

export function plugin(name) {
  return isNativeApp() && window.Capacitor.Plugins ? window.Capacitor.Plugins[name] : null;
}

let serviceOn = false;

/** Show the "Pulse is recording" notification and keep the app alive in the background. */
export async function startRecordingService(title) {
  const fs = plugin('ForegroundService');
  if (!fs) return false;
  try {
    const perm = await fs.checkPermissions();
    if (perm && perm.display !== 'granted') await fs.requestPermissions();
  } catch {
    /* older Android: no runtime notification permission */
  }
  try {
    await fs.startForegroundService({
      id: 4242,
      title: 'Pulse is recording',
      body: title ? `Heart rate · ${title}` : 'Heart rate from your WHOOP',
      smallIcon: 'ic_stat_pulse',
      silent: true,
      serviceType: 16, // FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE (Bluetooth strap)
    });
    serviceOn = true;
    return true;
  } catch {
    return false;
  }
}

export async function stopRecordingService() {
  const fs = plugin('ForegroundService');
  if (!fs || !serviceOn) return;
  try {
    await fs.stopForegroundService();
  } catch {
    /* already stopped */
  }
  serviceOn = false;
}

/** "16 4b 00 04" / "164b0004" → DataView */
export function hexToDataView(hex) {
  const clean = String(hex || '').replace(/[^0-9a-f]/gi, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return new DataView(bytes.buffer);
}

export const HR_SERVICE = '0000180d-0000-1000-8000-00805f9b34fb';
export const HR_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb';

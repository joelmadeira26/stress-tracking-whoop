// Web Bluetooth connection to a standard BLE heart-rate broadcaster (WHOOP "Heart Rate Broadcast").
import { parseHeartRate } from './hr.js';
import { isNativeApp, plugin, hexToDataView, HR_SERVICE, HR_MEASUREMENT } from './native.js';

export function bluetoothSupport() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isNativeApp() && plugin('BluetoothLe')) return { ok: true, isIOS: false, native: true };
  if (navigator.bluetooth && typeof navigator.bluetooth.requestDevice === 'function') {
    return { ok: true, isIOS };
  }
  return { ok: false, isIOS };
}

const RETRY_WAITS = [1000, 2000, 4000, 8000, 15000, 30000];

/**
 * Events (via callbacks):
 *  onStatus(status, info)  status ∈ 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'
 *  onReading(parsed, at)   every notification
 */
export class Strap {
  constructor({ onStatus = () => {}, onReading = () => {} } = {}) {
    this.onStatus = onStatus;
    this.onReading = onReading;
    this.device = null;
    this.char = null;
    this.status = 'idle';
    this.wanted = false;
    this.attempt = 0;
    this.retryTimer = null;
    this.lastReadingAt = 0;
    this.lastHr = null;
    this._onNotify = this._onNotify.bind(this);
    this._onDisconnect = this._onDisconnect.bind(this);
  }

  get deviceName() {
    return this.device ? this.device.name || 'Heart-rate strap' : null;
  }

  setStatus(status, info = {}) {
    this.status = status;
    this.onStatus(status, info);
  }

  /** Must be called from a user gesture. */
  async pick({ showAll = false } = {}) {
    const options = showAll
      ? { acceptAllDevices: true, optionalServices: ['heart_rate'] }
      : { filters: [{ services: ['heart_rate'] }] };
    const device = await navigator.bluetooth.requestDevice(options);
    if (this.device && this.device !== device) {
      this.device.removeEventListener('gattserverdisconnected', this._onDisconnect);
    }
    this.device = device;
    device.addEventListener('gattserverdisconnected', this._onDisconnect);
    this.wanted = true;
    this.attempt = 0;
    await this._connect();
  }

  async _connect() {
    clearTimeout(this.retryTimer);
    this.setStatus(this.attempt ? 'reconnecting' : 'connecting', { attempt: this.attempt });
    try {
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService('heart_rate');
      const ch = await service.getCharacteristic('heart_rate_measurement');
      if (this.char) this.char.removeEventListener('characteristicvaluechanged', this._onNotify);
      this.char = ch;
      ch.addEventListener('characteristicvaluechanged', this._onNotify);
      await ch.startNotifications();
      this.attempt = 0;
      this.setStatus('connected', { name: this.deviceName });
    } catch (err) {
      if (!this.wanted) return;
      this._scheduleRetry(err);
    }
  }

  _scheduleRetry(err) {
    const wait = RETRY_WAITS[Math.min(this.attempt, RETRY_WAITS.length - 1)];
    this.attempt += 1;
    this.setStatus('reconnecting', { attempt: this.attempt, wait, error: err && err.message });
    this.retryTimer = setTimeout(() => this._connect(), wait);
  }

  _onDisconnect() {
    this.char = null;
    if (this.wanted) this._scheduleRetry();
    else this.setStatus('disconnected');
  }

  _onNotify(ev) {
    try {
      const parsed = parseHeartRate(ev.target.value);
      this.lastReadingAt = Date.now();
      this.lastHr = parsed.hr;
      this.onReading(parsed, this.lastReadingAt);
    } catch (e) {
      /* ignore malformed packet */
    }
  }

  /** Try again right now (e.g. when the tab becomes visible). */
  retryNow() {
    if (this.wanted && this.device && this.status !== 'connected') {
      this.attempt = Math.max(1, this.attempt);
      this._connect();
    }
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    this.setStatus('disconnected');
  }
}

/**
 * Same interface as Strap, using the Android app's native Bluetooth (works with the screen off).
 */
export class NativeStrap extends Strap {
  constructor(cb) {
    super(cb);
    this.ble = plugin('BluetoothLe');
    this.deviceId = null;
    this.deviceLabel = null;
    this.listeners = [];
    this.ready = false;
  }

  get deviceName() {
    return this.deviceId ? this.deviceLabel || 'Heart-rate strap' : null;
  }

  async pick({ showAll = false } = {}) {
    if (!this.ready) {
      await this.ble.initialize({ androidNeverForLocation: true });
      this.ready = true;
    }
    try {
      const on = await this.ble.isEnabled();
      if (on && on.value === false) await this.ble.requestEnable();
    } catch {
      /* not supported on every phone */
    }
    const dev = await this.ble.requestDevice(showAll ? { optionalServices: [HR_SERVICE] } : { services: [HR_SERVICE] });
    if (this.deviceId && this.deviceId !== dev.deviceId) await this._cleanup(true);
    this.deviceId = dev.deviceId;
    this.deviceLabel = dev.name;
    this.wanted = true;
    this.attempt = 0;
    await this._connect();
  }

  async _cleanup(disconnect) {
    for (const l of this.listeners) {
      try {
        await l.remove();
      } catch {
        /* ignore */
      }
    }
    this.listeners = [];
    if (disconnect && this.deviceId) {
      try {
        await this.ble.disconnect({ deviceId: this.deviceId });
      } catch {
        /* ignore */
      }
    }
  }

  async _connect() {
    clearTimeout(this.retryTimer);
    this.setStatus(this.attempt ? 'reconnecting' : 'connecting', { attempt: this.attempt });
    try {
      await this._cleanup(false);
      const id = this.deviceId;
      this.listeners.push(await this.ble.addListener(`disconnected|${id}`, () => this._onDisconnect()));
      await this.ble.connect({ deviceId: id, timeout: 15000 });
      this.listeners.push(
        await this.ble.addListener(`notification|${id}|${HR_SERVICE}|${HR_MEASUREMENT}`, (ev) =>
          this._onNotify({ target: { value: typeof (ev && ev.value) === 'string' ? hexToDataView(ev.value) : ev && ev.value } }),
        ),
      );
      await this.ble.startNotifications({ deviceId: id, service: HR_SERVICE, characteristic: HR_MEASUREMENT });
      this.attempt = 0;
      this.setStatus('connected', { name: this.deviceName });
    } catch (err) {
      if (!this.wanted) return;
      this._scheduleRetry(err);
    }
  }

  retryNow() {
    if (this.wanted && this.deviceId && this.status !== 'connected') {
      this.attempt = Math.max(1, this.attempt);
      this._connect();
    }
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this._cleanup(true);
    this.setStatus('disconnected');
  }
}

/** The right strap implementation for where Pulse is running. */
export function createStrap(cb) {
  return isNativeApp() && plugin('BluetoothLe') ? new NativeStrap(cb) : new Strap(cb);
}

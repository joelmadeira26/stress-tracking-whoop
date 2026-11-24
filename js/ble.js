// Web Bluetooth connection to a standard BLE heart-rate broadcaster (WHOOP "Heart Rate Broadcast").
import { parseHeartRate } from './hr.js';

export function bluetoothSupport() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
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

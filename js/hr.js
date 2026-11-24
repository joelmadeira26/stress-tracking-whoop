// Heart Rate Measurement (GATT characteristic 0x2A37) parser.
// Flags byte:
//   bit 0  – HR value format: 0 = uint8, 1 = uint16
//   bit 1-2 – sensor contact status (bit 2 = supported, bit 1 = detected)
//   bit 3  – Energy Expended present (uint16, kJ)
//   bit 4  – RR-Interval(s) present (uint16 each, units of 1/1024 s)

/** @param {DataView|ArrayBuffer|Uint8Array|number[]} input */
export function parseHeartRate(input) {
  const dv = toDataView(input);
  if (dv.byteLength < 2) throw new Error('Heart rate packet too short');
  const flags = dv.getUint8(0);
  const is16 = (flags & 0x01) !== 0;
  const contactSupported = (flags & 0x04) !== 0;
  const contactDetected = (flags & 0x02) !== 0;
  const hasEnergy = (flags & 0x08) !== 0;
  const hasRR = (flags & 0x10) !== 0;

  let offset = 1;
  let hr;
  if (is16) {
    if (dv.byteLength < 3) throw new Error('Heart rate packet too short for uint16');
    hr = dv.getUint16(offset, true);
    offset += 2;
  } else {
    hr = dv.getUint8(offset);
    offset += 1;
  }

  let energy = null;
  if (hasEnergy) {
    if (dv.byteLength >= offset + 2) energy = dv.getUint16(offset, true);
    offset += 2;
  }

  const rr = [];
  if (hasRR) {
    while (offset + 1 < dv.byteLength) {
      const raw = dv.getUint16(offset, true);
      rr.push(Math.round((raw / 1024) * 1000));
      offset += 2;
    }
  }

  return {
    hr,
    contact: contactSupported ? contactDetected : null,
    energy,
    rr,
  };
}

function toDataView(input) {
  if (input instanceof DataView) return input;
  if (input instanceof ArrayBuffer) return new DataView(input);
  if (ArrayBuffer.isView(input)) return new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) return new DataView(new Uint8Array(input).buffer);
  throw new Error('Unsupported input for parseHeartRate');
}

/**
 * Collapses notifications into ~1 sample per second.
 * Each sample: { t: ms epoch (start of second), hr, rr?: number[] }
 */
export class SampleAggregator {
  constructor(onSample) {
    this.onSample = onSample; // called with (sample, isNew)
    this.current = null;
  }
  push(parsed, now = Date.now()) {
    if (!parsed || !parsed.hr) return;
    const sec = Math.floor(now / 1000) * 1000;
    if (this.current && this.current.t === sec) {
      const c = this.current;
      c._n += 1;
      c._sum += parsed.hr;
      c.hr = Math.round(c._sum / c._n);
      if (parsed.rr.length) c.rr = (c.rr || []).concat(parsed.rr);
      this.onSample(this.public(c), false);
    } else {
      this.current = { t: sec, hr: parsed.hr, _n: 1, _sum: parsed.hr };
      if (parsed.rr.length) this.current.rr = parsed.rr.slice();
      this.onSample(this.public(this.current), true);
    }
  }
  public(c) {
    const s = { t: c.t, hr: c.hr };
    if (c.rr && c.rr.length) s.rr = c.rr.slice();
    return s;
  }
}

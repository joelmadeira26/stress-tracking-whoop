// Privacy lock for meetings: a PIN (stored only as a salted SHA-256 hash) and, optionally,
// the phone's fingerprint / face unlock through WebAuthn (platform authenticator).

const enc = new TextEncoder();
let unlockedUntil = 0;

export async function hashPin(pin) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(`pulse-lock:${pin}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isUnlocked() {
  return Date.now() < unlockedUntil;
}
export function markUnlocked(minutes = 15) {
  unlockedUntil = Date.now() + minutes * 60000;
}
export function relock() {
  unlockedUntil = 0;
}

export async function checkPin(pin, hash) {
  return !!hash && (await hashPin(pin)) === hash;
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function biometricAvailable() {
  try {
    return !!(window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()));
  } catch {
    return false;
  }
}

/** Register fingerprint/face unlock. Returns the credential id to store. */
export async function registerBiometric() {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Pulse' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'pulse-user', displayName: 'Pulse' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60000,
    },
  });
  return b64(cred.rawId);
}

/** Ask for fingerprint/face. Resolves true when the phone verified the user. */
export async function verifyBiometric(credId) {
  const res = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: unb64(credId), transports: ['internal'] }],
      userVerification: 'required',
      timeout: 60000,
    },
  });
  return !!res;
}

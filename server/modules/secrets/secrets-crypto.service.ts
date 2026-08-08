/**
 * AES-256-GCM envelope encryption for secret values (PRD §8.2–8.3), built
 * on node:crypto only — no new npm dependencies.
 *
 * Storage layout (documented choice):
 *   secrets.nonce      (BLOB) = 12-byte random IV, unique per encryption.
 *   secrets.ciphertext (BLOB) = encrypted bytes || 16-byte GCM auth tag,
 *                               i.e. the tag is APPENDED to the ciphertext.
 *
 * Appending the tag keeps the whole payload in the single existing
 * `ciphertext` column (no schema change); `decryptSecret` slices the
 * trailing 16 bytes off and feeds them to `setAuthTag()`. Tampering with
 * either part makes GCM verification fail, so a corrupted/tampered row
 * throws instead of returning garbage plaintext.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type EncryptedPayload = {
  /** encrypted bytes || 16-byte auth tag */
  ciphertext: Buffer;
  /** 12-byte random IV */
  nonce: Buffer;
};

export function encryptSecret(plaintext: string, masterKey: Buffer): EncryptedPayload {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([encrypted, tag]), nonce };
}

export function decryptSecret(payload: EncryptedPayload, masterKey: Buffer): string {
  const { ciphertext, nonce } = payload;
  if (ciphertext.length <= TAG_BYTES) {
    throw new Error('Stored ciphertext is truncated (missing GCM auth tag)');
  }
  const encrypted = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, masterKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

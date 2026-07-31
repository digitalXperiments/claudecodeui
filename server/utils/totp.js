import { generateSecret, generateURI, verify } from 'otplib';

const TOTP_ISSUER = 'CloudCLI';
// Allow one 30s step of clock drift between server and authenticator app.
const EPOCH_TOLERANCE_SECONDS = 30;

/** Generates a new base32-encoded TOTP secret. */
export const generateTotpSecret = () => generateSecret();

/** Builds the otpauth:// URI authenticator apps can scan as a QR code. */
export const generateTotpUri = (secret, username) =>
  generateURI({ issuer: TOTP_ISSUER, label: username, secret });

/** Returns true if the given 6-digit code is valid for the secret. */
export const verifyTotpCode = async (secret, code) => {
  if (!secret || !code) {
    return false;
  }
  const result = await verify({
    secret,
    token: String(code).trim(),
    epochTolerance: EPOCH_TOLERANCE_SECONDS,
  });
  return result.valid;
};

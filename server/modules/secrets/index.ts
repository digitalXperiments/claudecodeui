export { default as secretsRoutes } from '@/modules/secrets/secrets.routes.js';
export { secretsService } from '@/modules/secrets/secrets.service.js';
export {
  configureSecretsKeyDir,
  getMasterKey,
  resolveSecretsDir,
} from '@/modules/secrets/secrets-key.service.js';
export {
  decryptSecret,
  encryptSecret,
  type EncryptedPayload,
} from '@/modules/secrets/secrets-crypto.service.js';
export { keychainService } from '@/modules/secrets/secrets-keychain.service.js';
export * from '@/modules/secrets/secrets.types.js';

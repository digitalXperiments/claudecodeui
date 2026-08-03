// Express router mounted at /api/assets by server/index.js (upload + serving
// of chat image attachments stored in the global ~/.cloudcli/assets folder).
export { default as assetsRoutes } from './assets.routes.js';
// Other modules that write into the same global folder (e.g. Mission Control
// article images) go through these helpers rather than re-deriving the path.
export {
  ensureImageAssetsDir,
  resolveImageAssetFile,
  isAllowedImageMimeType,
} from './services/image-assets.service.js';

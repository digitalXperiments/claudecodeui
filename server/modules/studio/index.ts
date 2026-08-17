export { default as studioRoutes } from '@/modules/studio/studio.routes.js';
export {
  studioService,
  designStudioRoster,
  buildIdeatePrompt,
  promotePrototypeFromWorkspace,
} from '@/modules/studio/studio.service.js';
export type {
  StudioPrototype,
  StudioPrototypeDetail,
  CreateStudioPrototypeInput,
} from '@/modules/studio/studio.types.js';
export type { StudioSeatProfile } from '@/modules/studio/studio.profiles.js';

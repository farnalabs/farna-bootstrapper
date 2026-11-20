/**
 * Public types only. The CLI is the product surface in this slice; behaviour
 * lives behind the command modules.
 */
export type { Config, TargetConfig } from './config/schema.js';
export type { Lockfile } from './lock/lockfile.js';
export type { RendererIdentity, RenderRequest, RenderResult, RenderTarget } from './render/port.js';

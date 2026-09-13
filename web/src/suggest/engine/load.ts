import type { EngineModule } from './types'

/**
 * The seam between the page and the library.
 *
 * This module imports nothing from `@mlc-ai/web-llm`, statically or otherwise, except
 * through the `import()` below. That is what makes the library a separate chunk: a
 * static import anywhere on the path from `main.tsx` would pull six megabytes and three
 * asset hosts into the bundle the first screen waits for, however lazily the feature
 * behaved at run time.
 *
 * State-machine tests replace this module with an injected `EngineModule`, and component
 * tests render stores without crossing this import. `contract.drift.test.ts` deliberately
 * imports the installed library and the real adapter module to compare the pin, but creates
 * no engine and downloads nothing. The model-focused browser suites replace the built
 * chunk itself; other rendered browser suites may evaluate it, while their per-context
 * host guard aborts every public model-asset request.
 */

/**
 * Whether this browser has WebGPU at all, without loading anything.
 *
 * Checked here, before the import, so an unsupported device never fetches the model
 * chunk either. The full verdict still comes from `probeSupport`, which asks the adapter
 * about the feature the pinned shaders need; this is only the cheap gate that decides
 * whether it is worth downloading the code that can ask.
 */
export function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

/**
 * Fetches the model chunk and returns its module.
 *
 * Rejects when the chunk cannot be fetched, which is the ordinary case for a visitor who
 * went offline between the page load and the start of this one, and for a network that
 * blocks the asset host. `useSuggest` treats it as a load failure like any other, so a
 * blocked chunk is a state on the panel and never an application error.
 */
export async function loadEngineModule(): Promise<EngineModule> {
  const loaded = await import('./webllm')
  return loaded.default
}

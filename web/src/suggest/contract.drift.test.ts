import { prebuiltAppConfig } from '@mlc-ai/web-llm'
import { describe, expect, it } from 'vitest'
import { MODEL_ID, MODEL_REQUIRED_FEATURE, MODEL_VRAM_MB } from './contract'
import { APP_CONFIG, PINNED_MODEL } from './engine/webllm'

/**
 * The guard on the pinned model.
 *
 * `PINNED_MODEL` is a copy of one record out of `@mlc-ai/web-llm`'s own catalogue, and the
 * copy is the point: passing the catalogue would let a library upgrade move the weights,
 * bump the compiled shader library, or raise the memory requirement of what a visitor
 * downloads, with nothing in this repository recording that it changed. Pinning the record
 * means an upgrade has to be read and accepted.
 *
 * A copy nothing checks is the other failure, and it is worse than the first: the record
 * would keep naming a `model_lib` built for a runtime the library no longer ships, and the
 * only symptom would be a load that fails on a visitor's device. So the copy is compared
 * against the catalogue field by field here, and a bump that moves any of it fails the
 * frontend gate instead.
 *
 * This is the same arrangement as `snapshot/contract.drift.test.ts` and
 * `verify/contract.drift.test.ts`, with the library's catalogue standing in for the Go
 * sources. It reads the installed dependency rather than the network, so it needs no
 * model host and downloads nothing.
 */

const catalogued = prebuiltAppConfig.model_list.find((record) => record.model_id === MODEL_ID)

describe('the pinned model against the library that loads it', () => {
  /*
   * First, because every assertion below is vacuous without it. A model dropped from the
   * catalogue is the case that matters most: the library would no longer ship a shader
   * library built for it, so the pin would name assets nothing supports.
   */
  it('is still a model this version of the library publishes', () => {
    expect(prebuiltAppConfig.model_list.length).toBeGreaterThan(1)
    expect(catalogued).toBeDefined()
  })

  /*
   * Field by field rather than as one object comparison, so a failure names which part
   * moved. The weights URL and the shader library are two different upgrades to read: one
   * changes what a visitor downloads, the other changes what runs it.
   */
  it('names the weights and the shader library the catalogue names', () => {
    expect(PINNED_MODEL.model).toBe(catalogued?.model)
    expect(PINNED_MODEL.model_lib).toBe(catalogued?.model_lib)
  })

  it('declares the memory the catalogue declares, and states it in the contract', () => {
    expect(PINNED_MODEL.vram_required_MB).toBe(catalogued?.vram_required_MB)
    expect(MODEL_VRAM_MB).toBe(catalogued?.vram_required_MB)
  })

  /*
   * `probeSupport` refuses a device whose adapter lacks this, before anything is fetched.
   * A feature added to the record and not to the contract would be a feature nothing
   * probes for, so the load would begin and then fail inside the library.
   */
  it('probes for every feature the catalogue requires', () => {
    expect(catalogued?.required_features).toEqual([MODEL_REQUIRED_FEATURE])
    expect(PINNED_MODEL.required_features).toEqual(catalogued?.required_features)
  })

  it('keeps the context window and low-resource flag the catalogue sets', () => {
    expect(PINNED_MODEL.overrides).toEqual(catalogued?.overrides)
    expect(PINNED_MODEL.low_resource_required).toBe(catalogued?.low_resource_required)
  })
})

describe('the configuration the engine is created with', () => {
  /*
   * One model, so there is nothing for a caller to select. The privacy promise is that
   * assets come from the pinned configuration and nowhere else, and a list with a second
   * entry in it is a list something could choose from.
   */
  it('offers exactly the pinned model and no other', () => {
    expect(APP_CONFIG.model_list).toEqual([PINNED_MODEL])
  })

  /*
   * The Cache API rather than IndexedDB, which is what makes a second visit free. It is
   * asserted because it is the whole basis of the cache-reuse behaviour the panel reports
   * to a visitor: `isCached` asks this backend, and a changed default would make the
   * "already stored in this browser" line wrong rather than merely slow.
   */
  it('stores the assets in the cache the panel reports on', () => {
    expect(APP_CONFIG.cacheBackend).toBe('cache')
  })
})

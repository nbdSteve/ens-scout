import { useEffect, type ReactNode } from 'react'

import { startAmbient, stopAmbient } from './ambient'

/**
 * The optical background.
 *
 * Four fixed siblings, each blending straight against the paper: the beam ribbon
 * and the interference lines inside it, the caustic where the ribbon lands, the
 * glass object, and the two specular highlights. `index.css` places and paints
 * them; this component only puts them in the document and starts the clock.
 *
 * They are returned as a bare fragment, and `App` renders them before `<main>`
 * rather than inside anything. A wrapper element would be a stacking or isolation
 * group, and `mix-blend-mode` would then composite against that wrapper's
 * backdrop instead of against the paper: the whole system would go flat with no
 * error reported anywhere. `#root` is part of the same contract, which is why a
 * browser test asserts it rather than a comment asking someone to remember.
 *
 * Every layer is decoration. It carries no status, no name, and no boundary, so
 * it is hidden from assistive technology and takes no pointer events. Nothing on
 * the page can be read only by looking at the light.
 */
export function Optics(): ReactNode {
  // One effect, and the only thing that ever starts or stops the loop. The
  // start/stop pair is refcounted, because `StrictMode` mounts this twice in
  // development and tears it down once.
  useEffect(() => {
    startAmbient()
    return stopAmbient
  }, [])

  return (
    <>
      <div aria-hidden="true" id="beam">
        <div className="ribbon" />
        <div className="striae" />
      </div>
      <div aria-hidden="true" id="caustic">
        <div className="knot" />
        <div className="rings" />
      </div>
      <div aria-hidden="true" id="lens">
        <div className="layer cast" />
        <div className="layer body" />
        <div className="layer rim" />
      </div>
      <div aria-hidden="true" id="spec">
        <div className="glass" />
        <div className="hot" />
      </div>
    </>
  )
}

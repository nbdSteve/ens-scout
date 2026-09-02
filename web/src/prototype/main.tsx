import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted, weight-axis only: the woff2 is bundled and served from this origin,
// so the page still contacts nothing but itself.
import '@fontsource-variable/instrument-sans/wght.css'
import { Prototype } from './Prototype'
import './prototype.css'

/**
 * The prototype's entry point, separate from the site's.
 *
 * Two Vite inputs rather than a route inside the app: the shipped bundle then has
 * no reference to any of this, and `/` keeps loading exactly the code it loaded
 * before. Deleting the prototype is deleting a directory and one config line.
 */
const container = document.getElementById('root')
if (container === null) {
  throw new Error('the prototype page is missing its #root element')
}

createRoot(container).render(
  <StrictMode>
    <Prototype />
  </StrictMode>,
)

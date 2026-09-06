import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'

/**
 * The entry point.
 *
 * `StrictMode` is on in development, where it double-invokes effects. That is kept
 * deliberately: the snapshot loader must tolerate being started twice and torn down
 * once, because a real visitor triggers the same sequence by navigating away
 * mid-load.
 */
const container = document.getElementById('root')
if (container === null) {
  throw new Error('the page is missing its #root element')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

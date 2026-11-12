import '@fontsource-variable/archivo/wdth.css'
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Board } from './Board.tsx'

const root = document.getElementById('root')
if (root === null) throw new Error('index.html is missing #root')
createRoot(root).render(
  <StrictMode>
    <Board />
  </StrictMode>,
)

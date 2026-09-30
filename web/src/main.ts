import './style.css'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('#app element missing')

app.innerHTML = `
  <h1>WalkPad</h1>
  <p>Scaffold only. World mode: <code>${import.meta.env.VITE_WORLD_MODE ?? 'flat'}</code></p>
`

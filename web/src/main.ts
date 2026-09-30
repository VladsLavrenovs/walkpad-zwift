import './style.css'
import { App } from './app'
import { loadConfig } from './config'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('#app element missing')
new App(root, loadConfig(import.meta.env, window.location.search))

import { mount } from '@termterm/ui'
import { createApi } from './api'

window.termterm = createApi()
mount(document.getElementById('root')!)

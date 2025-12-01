import typescriptLogo from '../assets/typescript.svg'
import viteLogo from '/vite.svg'
import {defineComponent, html} from '../lib/components';
import {Counter} from "./counter";

export const App = defineComponent<{client?: boolean}>(({client = true}) =>
    ((children) => () => html`<div>
        <a href="https://vite.dev">
            <img src="${viteLogo}" alt="vite logo" class="logo" />
        </a>
        
        <a href="https://www.typescriptlang.org/">
            <img src="${typescriptLogo}" alt="typescript logo" class="logo vanilla" />
        </a>
        
        <h1>Vite + TypeScript ${client ? 'CSR' : 'SSR'}</h1>
        
        ${children.Counter}
        
        <p>Click logos to learn more</p>
    </div>`)({
        Counter: Counter({ label: "Clicks" })
    }));
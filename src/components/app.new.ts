import typescriptLogo from '../assets/typescript.svg'
import viteLogo from '/vite.svg'
import {html} from '../lib/components.ts';
import {signal} from "../lib/signals.ts";
import {Counter} from "./counter.new";
import {ListItem} from "./list-item.new.ts";

type Props = {
    client?: boolean
};

export function App({client = true} : Props) {
    const test = signal<string[]>([]);
    const newValue = signal('');

    const handleSubmit = (e: SubmitEvent) => {
        e.preventDefault();
        test.set(t => [...t, newValue()]);
        newValue.set('');
    }

    return html`<div>
        <a href="https://vite.dev">
            <img src="${viteLogo}" alt="vite logo" class="logo"/>
        </a>

        <a href="https://www.typescriptlang.org/">
            <img src="${typescriptLogo}" alt="typescript logo" class="logo vanilla"/>
        </a>

        <h1>Vite + TypeScript ${client ? 'CSR' : 'SSR'}</h1>
        
        <ul>
            ${test.map(t => ListItem({text: t}))}
        </ul>

        ${Counter({label: "Clicks"})}
        
        <form onsubmit="${handleSubmit}">
            <div style="margin-bottom: 10px;">
                <!-- Mise à jour automatique de newValue à l'input -->
                <input type="text" value="${newValue}" />
            </div>
            
            <button type="submit">Créer un item</button>
        </form>

        <p>Click logos to learn more</p>
    </div>`;
}
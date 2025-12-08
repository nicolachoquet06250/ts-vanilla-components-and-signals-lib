### Documentation complète — nc-signals-components
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/nicolachoquet06250/nc-signals-components/npm-package-deploy.yml?branch=main&style=for-the-badge&logo=github&label=nc-signals-components)

[![NPM Package](https://img.shields.io/npm/v/nc-signals-components?style=for-the-badge&logo=npm&logoColor=red&label=nc-signals-components)](https://www.npmjs.com/package/nc-signals-components)
![NPM Unpacked Size](https://img.shields.io/npm/unpacked-size/nc-signals-components?style=for-the-badge&logo=npm&logoColor=red&label=nc-signals-components)

Dernière mise à jour: 2025-12-05 14:41

Cette documentation présente l’installation, le démarrage rapide (client et serveur), les conventions de composants, ainsi qu’un flux de build côté Go à partir de vos composants TypeScript via le script `ts2go`.

---

### Sommaire

- [Installation](#installation)
  - [Installation npm](#installation-npm)
  - [Utilisation directement dans un module sans build](#utilisation-directement-dans-un-module-sans-build)
  - [Utilisation dans le navigateur](#utilisation-dans-le-navigateur)
- [Quickstart](#quickstart)
  - [Rendue côté client](#rendue-côté-client)
    - [Avec le plugin vite](#avec-le-plugin-vite)
    - [Sans le plugin vite](#sans-le-plugin-vite)
  - [Rendu côté serveur](#rendu-côté-serveur)
    - [Avec le plugin vite](#avec-le-plugin-vite)
    - [Sans le plugin vite](#sans-le-plugin-vite)
- [Convention des composants](#convention-des-composants)
- [Build en Go](#build-en-go)

---

### Installation

#### Installation npm

Prérequis: Node.js 18+ recommandé.

```bash
# Créer un nouveau projet Vite (ex. vanilla-ts)
npm create vite@latest my-app --template vanilla-ts
cd my-app

# Installer la librairie
npm i nc-signals-components

# Démarrer en développement
npm run dev
```

Vous pouvez ensuite importer les API nécessaires (réactivité, composants, helpers) dans vos fichiers TypeScript:

```ts
import { signal, computed, defineComponent, html, mount, renderToString } from 'nc-signals-components';
```

#### Utilisation directement dans un module sans build

Pour tester rapidement dans un environnement moderne compatible ESM sans étape de build:

```ts
import lib from 'https://cdn.jsdelivr.net/npm/nc-signals-components/+esm';

// Exemple minimal
const { signal, defineComponent, html, mount } = lib;

const Counter = defineComponent(() => {
  const c = signal(0);
  return html`<button onclick="${() => c.set(v => v + 1)}">${c}</button>`;
});

mount(Counter(), document.getElementById('app')!);
```

#### Utilisation dans le navigateur

Sans bundler, via import dynamique:

```ts
import('https://cdn.jsdelivr.net/npm/nc-signals-components/+esm').then(({ signal, defineComponent, html, mount }) => {
  const App = defineComponent(() => html`<div>Hello</div>`);
  mount(App(), document.querySelector('#app')!);
});
```

Avec Import Map dans une page HTML:

```html
<script type="importmap">
{
  "imports": {
    "nc-signals-components": "https://cdn.jsdelivr.net/npm/nc-signals-components/+esm"
  }
}
</script>
<script type="module">
    import {signal, defineComponent, html, mount} from 'nc-signals-components';

    const Counter = defineComponent(() => {
        const counter = signal(0)

        const handleIncrement = () => counter.set(c => c + 1)
        const handleDecrement = (e) => {
            e.preventDefault();
            counter.set(c => c - 1)
        }

        return html`<button onclick="${handleIncrement}" oncontextmenu="${handleDecrement}">
                ${counter}
            </button>`
    });

    const App = defineComponent(() => html`<div>
        Hello world
    </div>

    ${Counter()}`);

    mount(App(), document.querySelector('#app'))
</script>
```

---

### Quickstart

#### Rendue côté client

##### Avec le plugin vite

Lorsque vous utilisez le plugin `autoComponentsPlugin`, écrivez des fonctions `PascalCase` qui retournent directement `html`. Le plugin les transforme en composants utilisables sans appeler explicitement `defineComponent`.

```ts
// src/components/Counter.ts
import { html, signal } from 'nc-signals-components';

export function Counter() {
  let c = signal(0);
  const inc = () => { c.set(c => c + 1); };
  const dec = (e: Event) => { e.preventDefault(); c.set(c => c - 1); };
  return html`<button onclick="${inc}" oncontextmenu="${dec}">${c}</button>`;
}
```

Configuration Vite minimale:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { autoComponentsPlugin } from 'nc-signals-components/vite';

export default defineConfig({
  plugins: [autoComponentsPlugin()],
});
```

Entrée client:

```ts
// src/main.ts
import { html, mount } from 'nc-signals-components';
import { Counter } from './components/Counter';

export function App() {
  return html`<div>
    <h1>Mon App</h1>
    ${Counter()}
  </div>`;
}

mount(App(), document.getElementById('app')!);
```

##### Sans le plugin vite

Exemple minimal de composant et montage avec Vite:

```ts
// src/components/Counter.ts
import { signal, defineComponent, html } from 'nc-signals-components';

export const Counter = defineComponent(() => {
  const count = signal(0);
  const inc = () => count.set(v => v + 1);
  const dec = (e: Event) => { e.preventDefault(); count.set(v => v - 1); };
  return html`<button onclick="${inc}" oncontextmenu="${dec}">${count}</button>`;
});
```

```ts
// src/main.ts
import { defineComponent, html, mount } from 'nc-signals-components';
import { Counter } from './components/Counter';

const App = defineComponent(() => html`<div>
  <h1>Mon App</h1>
  ${Counter()}
</div>`);

mount(App(), document.getElementById('app')!);
```

Avec Vite, il suffit d’exécuter:

```bash
npm run dev
```

Le plugin Vite optionnel `autoComponentsPlugin` peut transformer automatiquement des fonctions `PascalCase` retournant `html` en composants (voir [Convention des composants](#convention-des-composants)).

#### Rendu côté serveur

##### Avec le plugin vite

Avec Vite et `autoComponentsPlugin`, vous pouvez écrire vos composants sous forme de fonctions. Le code SSR reste identique: vous invoquez `renderToString` sur le composant transformé. Exemple d’entrée SSR:

```ts
// src/entry-server.ts
import { html, renderToString } from 'nc-signals-components';

export function App() {
  return html`<main><h1>SSR</h1></main>`;
}

const { html: markup } = renderToString(App());
console.log(markup);
```

Configuration Vite (extrait):

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { autoComponentsPlugin } from 'nc-signals-components/vite';

export default defineConfig({
  plugins: [autoComponentsPlugin()],
  build: {
    rolldownOptions: {
      input: 'src/entry-server.ts',
    },
    manifest: true,
  },
});
```

Vous pouvez ensuite exécuter le bundle SSR généré avec Node.

##### Sans le plugin vite

Pour produire une chaîne HTML côté serveur (Node.js):

```ts
// ssr.ts
import { defineComponent, html, renderToString } from 'nc-signals-components';

const App = defineComponent(() => html`<main><h1>SSR</h1></main>`);

const markup = renderToString(App());
console.log(markup);
```

Ensuite, servez le HTML via un serveur Express/Vite (exemple basé sur `src/server.js`):

```js
// src/server.js
import express from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

async function createServer() {
    const app = express();

    const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'custom',
    });

    app.use(vite.middlewares);

    app.use(express.static(path.resolve("dist")));

    app.get('/', async (_req, res) => {
        try {
            const {render} = await vite.ssrLoadModule('/src/entry-server.ts')
            const appHtml = render();

            const manifest = JSON.parse(fs.readFileSync('./dist/.vite/manifest.json', 'utf-8'));

            const mainScript = manifest['src/entry-client.ts'];

            const mainPath = mainScript.file;
            const stylePaths = mainScript.css;

            const html = `
            <!DOCTYPE html>
            <html lang="en">
              <head>
                <meta charset="UTF-8" />
                <link rel="icon" type="image/svg+xml" href="/vite.svg" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <title>SSR + Hydrate Signals</title>
                ${stylePaths.map(path => `<link rel="stylesheet" href="${path}">`).join('\n')}
              </head>
              <body>
                <div id="app">${appHtml}</div>
                <script async src="${mainPath}"></script>
              </body>
            </html>`;

            res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
        } catch (e) {
            vite.ssrFixStacktrace(e);
            console.error(e);
            res.status(500).end(e.message);
        }
    });

    app.listen(5173, () => {
        console.log('🚀 SSR server running at http://localhost:5173');
    });
}

createServer();
```

Commande d’exécution:

```bash
node src/server.js
```

Intégration dans un serveur HTTP Node (ex. Express/Fastify) consiste à appeler `renderToString(App())` et renvoyer `result.html` dans la réponse. L’hydratation côté client peut ensuite être faite avec `hydrate` si nécessaire.

---

### Convention des composants

Deux approches sont possibles, cohérentes avec le README/DOCUMENTATION existants:

1) Avec le plugin Vite `autoComponentsPlugin`
- Écrivez des fonctions exportées dont le nom commence par une majuscule et qui retournent directement `html` (une `View`).

```ts
// src/components/Button.ts
export function Button(props: { label: string }) {
  return html`<button>${props.label}</button>`;
}
```

2) Sans le plugin `autoComponentsPlugin`
- Exportez une constante qui appelle `defineComponent` prenant un callback qui retourne `html`.

```ts
import { defineComponent, html } from 'nc-signals-components';

export const Button = defineComponent((props: { label: string }) => {
  return html`<button>${props.label}</button>`;
});
```

Le plugin Vite peut transformer automatiquement la forme (1) vers un composant équivalent à:

```ts
export const Button = defineComponent((args: Record<string, unknown>) => ButtonView(args));
```

Intégration dans `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { autoComponentsPlugin } from 'nc-signals-components/vite';

export default defineConfig({
  plugins: [autoComponentsPlugin()],
});
```

---

### Build en Go

> ⚠️ Les composants qui ne sont pas des fonction utilisant le mot cle `function` ne seront pas détecter par le transpileur ts2go

Cette section s’appuie sur le script existant `scripts/ts2go.js`, qui extrait les templates `html\`…\`` de vos composants TypeScript (`src/components`) et génère des vues côté Go. Il propose également un scaffolding minimal d’un module Go SSR.

Points clés:
- Répertoire source analysé: `src/components`
- Répertoire de sortie Go: `go/ssr/components`
- Module SSR Go: `go/ssr` (généré au besoin)
- Dossier d’actifs: `go/assets`
- Options CLI: `--scaffold`/`--init`, `--force`

#### 1) Initialiser le projet Go (scaffold)

```bash
# depuis la racine du repo
ts2go --scaffold

# ou équivalent
ts2go --init

# ré-exécuter et écraser si nécessaire
ts2go --scaffold --force
```

Ce scaffold crée notamment:
- `go/ssr/go.mod` (module `signals-ssr`)
- `go/go.mod` (module racine `server-ssr` + replace vers `./ssr`)
- `go/ssr/ssr.scaffold.go` (types de base: `VNode`, ..., helpers et rendu string)
- Arborescence `go/ssr/components` et `go/assets`

#### 2) Générer les composants Go depuis TypeScript

```bash
ts2go
```

Le script parcourt `src/components`, et pour chaque composant exporté utilisant `html\`…\``, il émet un équivalent Go sous `go/ssr/components`. Les expressions complexes sont le plus souvent émisses en tant que texte source; une adaptation manuelle peut être nécessaire suivant les cas.

#### 3) Utiliser les vues Go générées

Exemple minimal pour rendre une page HTML côté Go (en supposant qu’un composant `App` ait été généré):

```go
// go/main.go
package main

import (
    "fmt"
    ssr "signals-ssr"
)

func main() {
    // Exemple: App() provient d’un fichier généré sous go/ssr/components
    app := ssr.App()
    // Rendu en string
    html := ssr.RenderToString(app, nil)
    fmt.Println(html)
}
```

Puis:

```bash
cd go

go run . [--port 8080]
```
Pour un serveur HTTP Go, encapsulez `RenderToString(Component(), nil)` dans un handler et renvoyez la chaîne HTML.

#### Remarques et limites

- Le générateur fait une extraction source des templates; certaines interpolations/événements/attributs peuvent nécessiter une adaptation côté Go.
- Utilisez `--force` lors du scaffold pour régénérer les fichiers par défaut si vous avez modifié la structure.
- L’API Go fournie dans `ssr.scaffold.go` expose des types et helpers suffisants pour composer des chaînes HTML de base.

---

Lien de l'exemple : https://github.com/nicolachoquet06250/exemple-nc-signals-components

---

Bon développement avec `nc-signals-components` !

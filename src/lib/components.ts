import type {StopHandle} from './signals';
import {watchEffect} from './signals';

// ---------- Types de base ----------

export type DomSetup = (root: Element) => void | (() => void);

export interface VNode {
    __isVNode: true;
    html: string;
    setups: DomSetup[];
}

export type View = () => VNode;
export type Component<P = {}> = (props: P) => View;

let renderMode: 'client' | 'server' = 'client';

export function defineComponent<P>(setup: (props: P) => View): Component<P> {
    return (props: P) => {
        const view = setup(props);
        (view as any).__isView = true;
        return view;
    };
}

// ---------- Helpers ----------

function isVNode(v: any): v is VNode {
    return v && typeof v === 'object' && v.__isVNode === true;
}

function isView(v: any): v is View {
    return typeof v === 'function' && (v as any).__isView === true;
}

function resolveScalar(v: any): string {
    if (v == null || v === false) return '';

    if (typeof v === 'function' && !(v as any).__isView) {
        return resolveScalar(v());
    }

    if (typeof v === 'object' && 'value' in v) {
        return resolveScalar(v.value);
    }

    if (Array.isArray(v)) {
        return v.map(resolveScalar).join('');
    }

    return String(v);
}

// ---------- html tag ----------

let partId = 0;

export function html(strings: TemplateStringsArray, ...values: any[]): VNode {
    const setups: DomSetup[] = [];
    let out = '';

    const textParts: DomSetup[] = [];
    const attrParts: DomSetup[] = [];

    for (let i = 0; i < strings.length; i++) {
        const prev = strings[i];
        out += prev;

        if (i >= values.length) continue;

        const expr = values[i];

        if (isView(expr) || isVNode(expr)) {
            const vnode = isView(expr) ? (expr as View)() : (expr as VNode);
            out += vnode.html;
            setups.push(...vnode.setups);
            continue;
        }

        const attrMatch = /([^\s"'=<>]+)\s*=\s*["']?$/.exec(prev);
        const inAttribute = !!attrMatch;

        if (inAttribute) {
            const attrMatch = /([^\s"'=<>]+)\s*=\s*["']?$/.exec(prev)!;
            const attrName = attrMatch[1]; // ex: onclick, oncontextmenu, class, src, ...

            // --- Event : onXxx="${() => ...}" ---
            if (attrName.startsWith('on') && typeof expr === 'function') {
                const id = `ev-part-${partId++}`;

                // 🔴 IMPORTANT : on écrit le même id en SSR et en client
                // pour que le DOM SSR et le DOM client aient la même valeur d'attribut.
                out += id;

                if (renderMode === 'client') {
                    attrParts.push(root => {
                        const selector = `[${attrName}="${id}"]`;
                        const el = root.querySelector<HTMLElement>(selector);
                        if (!el) return;

                        const eventName = attrName.slice(2); // onclick -> click
                        const handler = expr as (ev: Event) => void;

                        el.addEventListener(eventName, handler);
                        el.removeAttribute(attrName); // on nettoie onclick="..."

                        return () => {
                            el.removeEventListener(eventName, handler);
                        };
                    });
                }

                continue;
            }

            // --- Attribut "normal" ---
            const scalar = resolveScalar(expr);
            out += scalar;

            continue;
        }

        if (renderMode === 'server') {
            const text = resolveScalar(expr);
            const marker = `text-part-${partId++}`;
            out += `<!--s${marker}-->${text}<!--e${marker}-->`;
        } else {
            const id = `text-part-${partId++}`;

            out += `<!--s${id}--><!--e${id}-->`;

            textParts.push(root => {
                // Trouve les deux marqueurs
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
                let start: Comment | null = null;
                let end: Comment | null = null;

                let n = walker.nextNode();
                while (n) {
                    const c = n as Comment;
                    if (c.nodeValue === `s${id}`) start = c;
                    if (c.nodeValue === `e${id}`) { end = c; break; }
                    n = walker.nextNode();
                }
                if (!start || !end) return;

                let ptr = start.nextSibling;
                while (ptr && ptr !== end) {
                    const next = ptr.nextSibling;
                    ptr.parentNode?.removeChild(ptr);
                    ptr = next;
                }

                const textNode = document.createTextNode('');
                start.parentNode!.insertBefore(textNode, end);

                const stop = watchEffect(() => {
                    textNode.textContent = resolveScalar(expr);
                });

                return () => stop();
            });
        }
    }

    if (renderMode === 'client') {
        setups.push(root => {
            const cleanups: Array<() => void> = [];
            for (const p of [...attrParts, ...textParts]) {
                const c = p(root);
                if (typeof c === 'function') cleanups.push(c);
            }
            return () => cleanups.forEach(fn => fn());
        });
    }

    return {
        __isVNode: true as const,
        html: out,
        setups,
    };
}

// ---------- mount : CSR classique (pas SSR) ----------

export function mount(view: View, container: Element): StopHandle {
    const prevMode = renderMode;
    const prevPartId = partId;

    renderMode = 'client';
    partId = 0;

    try {
        const vnode = view();
        container.innerHTML = vnode.html;

        const cleanups: Array<() => void> = [];

        for (const setup of vnode.setups) {
            const c = setup(container);
            if (typeof c === 'function') cleanups.push(c);
        }

        return () => {
            cleanups.forEach(c => c());
            container.innerHTML = '';
        };
    } finally {
        renderMode = prevMode;
        partId = prevPartId;
    }
}

// ---------- hydrate : DOM déjà généré par le serveur ----------

export function hydrate(view: View, container: Element): StopHandle {
    const prevMode = renderMode;
    const prevPartId = partId;

    // Hydratation : on veut générer les mêmes ids que le SSR,
    // mais en mode "client" pour récupérer les setups (texte + events).
    renderMode = 'client';
    partId = 0;

    try {
        const vnode = view(); // appelle html(), qui remplit vnode.setups

        const cleanups: Array<() => void> = [];

        // ⚠️ on NE touche PAS au DOM ici (pas de innerHTML)
        for (const setup of vnode.setups) {
            const c = setup(container);
            if (typeof c === 'function') cleanups.push(c);
        }

        return () => {
            cleanups.forEach(c => c());
            // on laisse le DOM en place
        };
    } finally {
        renderMode = prevMode;
        partId = prevPartId;
    }
}


// ---------- SSR : renderToString (HTML complet + markers pour hydrate) ----------

export function renderToString<P>(
    compOrView: Component<P> | View,
    props?: P,
): string {
    const prevMode = renderMode;
    const prevPartId = partId;

    renderMode = 'server';
    partId = 0;

    try {
        const view = isView(compOrView)
            ? (compOrView as View)
            : (compOrView as Component<P>)(props as P);

        return view().html;
    } finally {
        renderMode = prevMode;
        partId = prevPartId;
    }
}


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

    // View -> rendre le HTML du view()
    if (isView(v)) {
        const vnode = (v as View)();
        return vnode.html;
    }

    // VNode -> HTML direct
    if (isVNode(v)) {
        return (v as VNode).html;
    }

    // Fonction (ex: Component sans props ou factory) -> invoquer et résoudre
    if (typeof v === 'function') {
        return resolveScalar((v as Function)());
    }

    // Signal/Computed-like ({ value })
    if (typeof v === 'object' && v && 'value' in v) {
        return resolveScalar(v.value);
    }

    // Tableau: concatène le HTML/texte de chaque élément
    if (Array.isArray(v)) {
        return v.map(resolveScalar).join('');
    }

    return String(v);
}

// Résout une expression potentiellement réactive en { html, setups }
function resolveToHTMLAndSetups(v: any): { html: string; setups: DomSetup[] } {
    if (v == null || v === false) return { html: '', setups: [] };

    // Unwrap Signal/Computed
    if (typeof v === 'object' && v && 'value' in v) {
        return resolveToHTMLAndSetups((v as any).value);
    }

    // View
    if (isView(v)) {
        const vnode = (v as View)();
        return { html: vnode.html, setups: [...vnode.setups] };
    }

    // VNode
    if (isVNode(v)) {
        const vnode = v as VNode;
        return { html: vnode.html, setups: [...vnode.setups] };
    }

    // Function (component factory without props, lazy builder, etc.)
    if (typeof v === 'function') {
        return resolveToHTMLAndSetups((v as Function)());
    }

    // Array: concatène tout
    if (Array.isArray(v)) {
        let html = '';
        const setups: DomSetup[] = [];
        for (const it of v) {
            const r = resolveToHTMLAndSetups(it);
            html += r.html;
            if (r.setups.length) setups.push(...r.setups);
        }
        return { html, setups };
    }

    // Scalaire -> texte
    return { html: String(v), setups: [] };
}

// ---------- html tag ----------

let partId = 0;

export function html(strings: TemplateStringsArray, ...values: any[]): () => VNode {
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

        // Détection plus robuste: on ne considère une interpolation comme valeur d'attribut
        // que si l'on est effectivement à l'intérieur d'une balise (<...>) et si le motif
        // correspond bien à un nom d'attribut valide suivi d'un '=' éventuellement guillemeté.
        // NOTE: Utiliser le tampon cumulé `out` (et non `prev`) permet de détecter correctement
        // plusieurs attributs successifs dans la même balise.
        const inTag = out.lastIndexOf('<') > out.lastIndexOf('>');
        const attrMatch = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*["']?$/.exec(out);
        const inAttribute = inTag && !!attrMatch;

        if (inAttribute) {
            const attrMatch = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*["']?$/.exec(out)!;
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

                        const eventName = attrName.slice(2).toLowerCase(); // onClick/onclick -> click, onContextMenu -> contextmenu
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
            // Pour SSR, on imprime la valeur résolue une fois.
            // Pour client, on insère un id marqueur et on configure une mise à jour réactive.

            const id = `attr-part-${partId++}`;
            if (renderMode === 'server') {
                const scalar = resolveScalar(expr);
                out += scalar;
            } else {
                // Ecrire un placeholder pour pouvoir retrouver l'élément
                out += id;
                attrParts.push(root => {
                    const selector = `[${attrName}="${id}"]`;
                    const el = root.querySelector<HTMLElement>(selector) as any;
                    if (!el) return;

                    // Nettoie l'attribut placeholder
                    el.removeAttribute(attrName);

                    const resolveAttr = (v: any): any => {
                        if (v == null || v === false) return v;
                        // unwrap Signal/Computed
                        if (typeof v === 'object' && 'value' in v) return resolveAttr((v as any).value);
                        // invoke factory functions
                        if (typeof v === 'function') return resolveAttr((v as Function)());
                        // arrays: join with space (useful for class)
                        if (Array.isArray(v)) return v.map(x => resolveAttr(x)).join(' ');
                        return v;
                    };

                    // reactive sync from source -> element
                    const stop = watchEffect(() => {
                        const raw = resolveAttr(expr);
                        const name = attrName.toLowerCase();

                        // value/checked syncing for form controls
                        if (name === 'value') {
                            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
                                const next = raw == null ? '' : String(raw);
                                // Avoid echo/jitter: only set when different
                                if (el.value !== next) {
                                    el.value = next;
                                }
                                return;
                            }
                        }

                        if (name === 'checked') {
                            if (el instanceof HTMLInputElement) {
                                const nextBool = !!raw;
                                if (el.checked !== nextBool) {
                                    el.checked = nextBool;
                                }
                                return;
                            }
                        }

                        // Generic attribute update
                        if (raw == null || raw === false) {
                            el.removeAttribute(attrName);
                        } else {
                            const val = String(raw);
                            if (el.getAttribute(attrName) !== val) {
                                el.setAttribute(attrName, val);
                            }
                        }
                    });

                    // If binding a Signal to value=..., attach input listener to update the signal
                    let detachInput: (() => void) | undefined;
                    if (
                        attrName.toLowerCase() === 'value'
                        && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)
                        && typeof expr === 'function'
                        && (expr as any).__isSignal === true
                    ) {
                        // determine coercion based on current value type
                        const current = (() => {
                            try { return resolveAttr(expr); } catch { return undefined; }
                        })();
                        const coerce = typeof current === 'number'
                            ? (v: string) => {
                                const n = v.trim() === '' ? NaN : Number(v);
                                return Number.isNaN(n) ? (expr as any).value : n;
                            }
                            : (v: string) => v;

                        const updateSignalFirst = (e: Event) => {
                            // update signal before any other oninput handlers
                            try {
                                const v = (e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
                                (expr as any).set ? (expr as any).set(coerce(v)) : (expr as any)(coerce(v));
                            } catch {}
                        };

                        // Use capture to ensure this runs before bubbling listeners potentially attached elsewhere
                        el.addEventListener('input', updateSignalFirst, { capture: true });
                        detachInput = () => el.removeEventListener('input', updateSignalFirst, { capture: true } as any);
                    }

                    return () => {
                        stop();
                        if (detachInput) detachInput();
                    };
                });
            }

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

                // Nettoie le contenu courant entre start et end
                const clearBetween = () => {
                    let ptr = start!.nextSibling;
                    while (ptr && ptr !== end) {
                        const next = ptr.nextSibling;
                        ptr.parentNode?.removeChild(ptr);
                        ptr = next;
                    }
                };

                let cleanupFns: Array<() => void> = [];

                const stop = watchEffect(() => {
                    // Cleanup previous setups
                    if (cleanupFns.length) {
                        for (const fn of cleanupFns) try { fn(); } catch {}
                        cleanupFns = [];
                    }

                    // Resolve dynamic content
                    const res = resolveToHTMLAndSetups(expr);

                    // Replace nodes between markers with parsed HTML
                    clearBetween();
                    if (res.html) {
                        const tpl = document.createElement('template');
                        tpl.innerHTML = res.html;
                        start!.parentNode!.insertBefore(tpl.content, end);
                    }

                    // Run setups in the context of the root container
                    for (const s of res.setups) {
                        const c = s(root);
                        if (typeof c === 'function') cleanupFns.push(c);
                    }
                });

                return () => {
                    // stop reactive effect and cleanup nodes/setups
                    stop();
                    if (cleanupFns.length) {
                        for (const fn of cleanupFns) try { fn(); } catch {}
                        cleanupFns = [];
                    }
                    clearBetween();
                };
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

    return () => ({
        __isVNode: true as const,
        html: out,
        setups,
    });
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


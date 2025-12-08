import type {StopHandle} from './signals';
import {watchEffect} from './signals';

// ---------- Types de base ----------

export type DomSetup = (root: Element) => void | (() => void);

export interface VNode {
    __isVNode: true;
    html: string;
    setups: DomSetup[];
}

export type View = {
    (): VNode
    mount(container: Element): StopHandle
    hydrate(container: Element): StopHandle
};
export type Component<P = {}> = (props: P) => View;

let renderMode: 'client' | 'server' = 'client';

export function defineComponent<P>(setup: (props: P) => View): Component<P> {
    return function (props: P): View {
        const view = setup(props);
        (view as any).__isView = true;
        view.mount = (container: Element) => mount(view, container);
        view.hydrate = (container: Element)=> hydrate(view, container);
        return view;
    }
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

export function html(strings: TemplateStringsArray, ...values: any[]) {
    const setups: DomSetup[] = [];
    let out = '';
    // Conserve une version non transformée pour la détection de contexte (<head>/<title>)
    let rawOut = '';

    const textParts: DomSetup[] = [];
    const attrParts: DomSetup[] = [];

    // Remplace les balises <head> dans le HTML client par un conteneur virtuel valide dans <body>
    const transformHeadTags = (s: string) =>
        s.replace(/<head(\s|>)/gi, '<div data-virtual-head$1').replace(/<\/head>/gi, '</div>');

    // Collecteur spécial pour construire un titre réactif complet
    // lorsqu'un <title> contient des expressions interpolées.
    // Il concatène les parties statiques + dynamiques et applique
    // une unique watchEffect qui met à jour document.title.
    type TitleSegment = string | (() => string);
    let titleCollector: { segments: TitleSegment[] } | null = null;

    // Pending injection to append right after the closing quote of the current attribute
    // Used in SSR to add robust data markers that won't be stripped (e.g., when on* attrs are removed)
    let pendingAfterAttr: string | null = null;

    for (let i = 0; i < strings.length; i++) {
        let chunk = strings[i];

        // If we need to inject something immediately after the attribute's closing quote,
        // we rewrite the next static chunk accordingly.
        if (pendingAfterAttr) {
            const first = chunk.charAt(0);
            if (first === '"' || first === '\'') {
                // Insert right after the closing quote
                chunk = first + pendingAfterAttr + chunk.slice(1);
            } else {
                // Fallback: just prepend (covers unquoted or unusual formatting)
                chunk = pendingAfterAttr + chunk;
            }
            pendingAfterAttr = null;
        }

        rawOut += chunk;
        out += (renderMode === 'client') ? transformHeadTags(chunk) : chunk;
        const prev = chunk;

        if (i >= values.length) continue;

        let expr = values[i];

        if (typeof expr === 'function' && expr.toString().includes('return view;')) {
            expr = expr();
        }

        if (isView(expr) || isVNode(expr)) {
            const vnode = isView(expr) ? (expr as View)() : (expr as VNode);
            rawOut += vnode.html;
            out += (renderMode === 'client') ? transformHeadTags(vnode.html) : vnode.html;
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

                // In SSR, also inject robust data-* markers that are unlikely to be stripped by
                // downstream tooling. These markers allow hydration even if inline on* attributes
                // are removed or altered in the consuming app.
                if (renderMode === 'server') {
                    const evName = attrName.slice(2).toLowerCase();
                    // Defer insertion right after the attribute's closing quote
                    pendingAfterAttr = ` data-s-eid="${id}" data-s-ename="${evName}"`;
                }

                if (renderMode === 'client') {
                    attrParts.push(root => {
                        // 1) Primary: data markers (work even if on* attributes are stripped by SSR pipeline)
                        let el = root.querySelector<HTMLElement>(`[data-s-eid="${id}"]`);
                        
                        // 2) Exact match on inline on* placeholder
                        if (!el) {
                            const selector = `[${attrName}="${id}"]`;
                            el = root.querySelector<HTMLElement>(selector) as any;
                        }

                        // Fallback hydratation : si l'attribut placeholder n'existe pas (strippé/modifié côté SSR),
                        // on se rabat sur le n-ième élément possédant cet attribut, par ordre d'apparition.
                        if (!el) {
                            const all = root.querySelectorAll<HTMLElement>(`[${attrName}]`);
                            const mapKey = '__eventIdxMap__';
                            const idxMap: Map<string, number> = ((root as any)[mapKey] ||= new Map<string, number>());
                            const nextIdx = idxMap.get(attrName) || 0;
                            if (nextIdx < all.length) {
                                el = all[nextIdx] as any;
                                idxMap.set(attrName, nextIdx + 1);
                            }
                        }

                        if (!el) return;

                        const eventName = attrName.slice(2).toLowerCase(); // onClick/onclick -> click, onContextMenu -> contextmenu
                        const handler = expr as (ev: Event) => void;

                        el.addEventListener(eventName, handler);
                        // Nettoyage de l'attribut inline pour éviter tout conflit/erreur navigateur
                        try { el.removeAttribute(attrName); } catch {}
                        // Remove data markers used for hydration
                        try { el.removeAttribute('data-s-eid'); } catch {}
                        try { el.removeAttribute('data-s-ename'); } catch {}

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
                    let el = root.querySelector<HTMLElement>(selector) as any;

                    // Hydration fallback: on SSR markup the placeholder id is not present.
                    // Try to bind by occurrence order to the next element that has this attribute.
                    if (!el) {
                        const all = root.querySelectorAll<HTMLElement>(`[${attrName}]`);
                        // Per-root index map to keep consistent ordering across multiple bindings
                        const mapKey = '__attrIdxMap__';
                        const idxMap: Map<string, number> = ((root as any)[mapKey] ||= new Map<string, number>());
                        const nextIdx = idxMap.get(attrName) || 0;
                        if (nextIdx < all.length) {
                            el = all[nextIdx] as any;
                            idxMap.set(attrName, nextIdx + 1);
                        }
                    }

                    if (!el) return;

                    // Nettoie l'attribut placeholder uniquement s'il correspond au placeholder
                    // (en hydratation SSR, la valeur réelle peut être présente et doit être respectée)
                    try {
                        if (el.getAttribute(attrName) === id) {
                            el.removeAttribute(attrName);
                        }
                    } catch {}

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
                                // Keep the DOM attribute "value" in sync as requested
                                const attrVal = el.getAttribute('value');
                                if (attrVal !== next) {
                                    // set the attribute to reflect the current signal value
                                    el.setAttribute('value', next);
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

        // Détection du contexte HEAD/TITLE pour brancher des comportements spéciaux (maj <head>)
        const lowerOut = rawOut.toLowerCase();
        const inHeadCtx = lowerOut.lastIndexOf('<head') > lowerOut.lastIndexOf('</head>');
        const inTitleCtx = lowerOut.lastIndexOf('<title') > lowerOut.lastIndexOf('</title>');

        if (renderMode === 'server') {
            const text = resolveScalar(expr);
            const marker = `text-part-${partId++}`;
            out += `<!--s${marker}-->${text}<!--e${marker}-->`;
            rawOut += `<!--s${marker}-->${text}<!--e${marker}-->`;
        } else {
            // Si on est dans <head><title> ... ${expr} ... </title>, on construit
            // un builder qui recompose le titre complet (parties statiques + dynamiques)
            // et applique une seule watchEffect.
            if (inHeadCtx && inTitleCtx) {
                // 1) Ajouter la portion statique de "prev" qui se trouve APRES l'ouverture <title...>
                const prevLower = prev.toLowerCase();
                if (!titleCollector) {
                    const openIdx = prevLower.lastIndexOf('<title');
                    if (openIdx !== -1) {
                        // trouver le '>' correspondant (dans la même chaîne prev)
                        const gtIdx = prev.indexOf('>', openIdx);
                        const staticStart = gtIdx === -1 ? (openIdx + '<title'.length) : (gtIdx + 1);
                        titleCollector = { segments: [] };
                        titleCollector.segments.push(prev.substring(staticStart));
                    } else {
                        // déjà dans un titre ouvert plus tôt, on prend tout prev
                        titleCollector = titleCollector || { segments: [] };
                        titleCollector.segments.push(prev);
                    }
                } else {
                    // Titre déjà en cours de collecte
                    titleCollector.segments.push(prev);
                }

                // 2) Ajouter le segment dynamique courant
                const initial = resolveScalar(expr);
                out += String(initial);
                rawOut += String(initial);
                // stocker un resolver dynamique
                titleCollector.segments.push(() => String(resolveScalar(expr)));

                // 3) Regarder la chaîne suivante pour voir si </title> y figure
                const nextStr = strings[i + 1] ?? '';
                const nextLower = nextStr.toLowerCase();
                const closeIdx = nextLower.indexOf('</title>');
                if (closeIdx !== -1) {
                    // Ajouter la partie statique avant </title>
                    const staticTail = nextStr.substring(0, closeIdx);
                    if (staticTail) titleCollector.segments.push(staticTail);

                    // Enregistrer une watch unique pour ce titre
                    const segments = titleCollector.segments.slice();
                    partId++; // consommer un id pour rester aligné avec SSR
                    textParts.push(() => {
                        const stop = watchEffect(() => {
                            try {
                                const built = segments.map(seg =>
                                    typeof seg === 'function' ? (seg as () => string)() : seg
                                ).join('');
                                if (typeof document !== 'undefined' && document.title !== built) {
                                    document.title = built;
                                }
                            } catch {}
                        });
                        return () => stop();
                    });

                    // Fin de collecte pour ce <title>
                    titleCollector = null;
                }
            } else {
                const id = `text-part-${partId++}`;

                out += `<!--s${id}--><!--e${id}-->`;
                rawOut += `<!--s${id}--><!--e${id}-->`;

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

        // Synchronisation des éventuels <head>...</head> rendus dans la vue
        setups.push(root => {
            // Cherche des balises <head> dans le fragment rendu et synchronise le titre/meta vers document.head
            const owner = `head-sync-${partId++}`;
            const heads = root.querySelectorAll('head, [data-virtual-head]');
            const observers: MutationObserver[] = [];
            const allowed = new Set(['title','meta','link','base','style']);

            const syncFrom = (h: Element) => {
                // Titre
                const t = h.querySelector('title');
                if (t) {
                    const txt = t.textContent ?? '';
                    if (typeof document !== 'undefined' && document.title !== txt) {
                        document.title = txt;
                    }
                }

                // Avertir si des tags non supportés sont utilisés dans <head>
                const allHeadChildren = h.querySelectorAll('*');
                allHeadChildren.forEach(el => {
                    const tag = el.tagName.toLowerCase();
                    if (!allowed.has(tag)) {
                        // avertir une fois par élément (marquer pour éviter répétition extrême)
                        if (!(el as any).__warnedUnsupportedHead) {
                            (el as any).__warnedUnsupportedHead = true;
                            try {
                                console.warn(`[signals] Balise <${tag}> dans <head> non prise en charge: elle ne sera pas synchronisée vers document.head.`);
                            } catch {}
                        }
                    }
                });

                // Synchroniser meta/link/base/style
                const existing = document.head.querySelectorAll(`[data-ssr-owner="${owner}"]`);
                existing.forEach(n => n.parentElement?.removeChild(n));

                const stripMarkers = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '');

                // meta, link, base -> clone direct
                const simpleCopy = h.querySelectorAll('meta, link, base');
                simpleCopy.forEach(el => {
                    const clone = el.cloneNode(true) as Element;
                    clone.setAttribute('data-ssr-owner', owner);
                    document.head.appendChild(clone);
                });

                // style -> reconstruire pour nettoyer les marqueurs/commentaires internes
                const styleEls = h.querySelectorAll('style');
                styleEls.forEach(el => {
                    const attrs: string[] = [];
                    // recopier les attributs du style original
                    for (const a of Array.from(el.attributes)) {
                        attrs.push(`${a.name}="${a.value}"`);
                    }
                    const style = document.createElement('style');
                    if (attrs.length) {
                        for (const a of Array.from(el.attributes)) {
                            try { style.setAttribute(a.name, a.value); } catch {}
                        }
                    }
                    style.setAttribute('data-ssr-owner', owner);
                    style.textContent = stripMarkers(el.textContent || '');
                    document.head.appendChild(style);
                });
            };

            heads.forEach(h => {
                // sync initial
                try { syncFrom(h); } catch {}
                // observe modifications pour resync
                const mo = new MutationObserver(() => {
                    try { syncFrom(h); } catch {}
                });
                mo.observe(h, { childList: true, characterData: true, subtree: true, attributes: true });
                observers.push(mo);

                // Après avoir branché l'observer et synchronisé initialement, on vide le contenu
                // du conteneur <head> virtuel et on le masque pour ne pas impacter l'affichage,
                // tout en conservant ce nœud dans le DOM du composant afin que les effets réactifs
                // puissent continuer à mettre à jour son contenu (qui sera répercuté dans document.head).
                try {
                    (h as HTMLElement).style.display = 'none';
                    h.setAttribute('aria-hidden', 'true');
                } catch {}
            });

            return () => {
                observers.forEach(o => o.disconnect());
                const owned = document.head.querySelectorAll(`[data-ssr-owner="${owner}"]`);
                owned.forEach(n => n.parentElement?.removeChild(n));
            };
        });
    }

    return (() => ({
        __isVNode: true as const,
        html: out,
        setups,
    })) as View;
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


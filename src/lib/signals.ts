// ---------- Types publics ----------

export interface Signal<T> {
    (): T;
    value: T;
    set(value: T | ((prev: T) => T)): void;
    update(updater: (prev: T) => T): void;
}

export interface CallableComputedReadonly<T> {
    (): T;
    readonly value: T;
}

export interface CallableComputedWritable<T> {
    (): T;
    (value: T): void;
    value: T;
    set(value: T): void;
}

export type ComputedGetter<T> = () => T;
export type ComputedSetter<T> = (value: T) => void;

export interface ComputedOptions<T> {
    get: ComputedGetter<T>;
    set(value: T): void;
}

export type Computed<T, T2 = 'readonly'|'writable'> = T2 extends 'readonly' ? CallableComputedReadonly<T> : CallableComputedWritable<T>;

export type SignalLike<T> = { value: T };

export type WatchSource<T> = SignalLike<T> | (() => T);

export type CleanupFn = () => void;
export type OnCleanup = (fn: CleanupFn) => void;
export type StopHandle = () => void;

// ---------- Array helpers typings (conditional methods for array-typed sources) ----------

type ElementOf<A> = A extends (infer U)[] ? U : never;

type ArraySourceMethods<T> = T extends any[]
    ? {
          map<U>(
              mapper: (
                  value: ElementOf<T>,
                  index: number,
                  array: ElementOf<T>[],
              ) => U,
          ): Computed<U[]>;
          filter(
              predicate: (
                  value: ElementOf<T>,
                  index: number,
                  array: ElementOf<T>[],
              ) => boolean,
          ): Computed<ElementOf<T>[]>;
          reduce(
              reducer: (
                  acc: ElementOf<T>,
                  value: ElementOf<T>,
                  index: number,
                  array: ElementOf<T>[],
              ) => ElementOf<T>,
          ): Computed<ElementOf<T>>;
          reduce<R>(
              reducer: (
                  acc: R,
                  value: ElementOf<T>,
                  index: number,
                  array: ElementOf<T>[],
              ) => R,
              initialValue: R,
          ): Computed<R>;
      }
    : {};

// ---------- Infrastructure interne (fonctionnelle) ----------

type Dep = Set<ReactiveEffect<any>>;

interface ReactiveEffect<T = any> {
    fn: () => T;
    scheduler?: () => void;
    deps: Set<Dep>;
    active: boolean;
}

let activeEffect: ReactiveEffect<any> | null = null;

// Map globale des dépendances (cible -> set d'effets)
const targetMap = new WeakMap<object, Dep>();

function getDep(target: object): Dep {
    let dep = targetMap.get(target);
    if (!dep) {
        dep = new Set();
        targetMap.set(target, dep);
    }
    return dep;
}

function cleanupEffect(effect: ReactiveEffect<any>): void {
    for (const dep of effect.deps) {
        dep.delete(effect);
    }
    effect.deps.clear();
}

function createReactiveEffect<T>(
    fn: () => T,
    scheduler?: () => void,
): ReactiveEffect<T> {
    return {
        fn,
        scheduler,
        deps: new Set(),
        active: true,
    };
}

function runEffect<T>(effect: ReactiveEffect<T>): T {
    if (!effect.active) {
        // exécution sans tracking si stoppé
        return effect.fn();
    }

    const prev = activeEffect;
    activeEffect = effect;

    // on nettoie les anciennes deps avant de re-tracker
    cleanupEffect(effect);

    try {
        return effect.fn();
    } finally {
        activeEffect = prev;
    }
}

function stopEffect(effect: ReactiveEffect<any>): void {
    if (!effect.active) return;
    effect.active = false;
    cleanupEffect(effect);
}

function track(target: object): void {
    if (!activeEffect) return;

    const dep = getDep(target);
    if (!dep.has(activeEffect)) {
        dep.add(activeEffect);
        activeEffect.deps.add(dep);
    }
}

function trigger(target: object): void {
    const dep = targetMap.get(target);
    if (!dep) return;

    // clone pour éviter les mutations pendant l’itération
    const effects = Array.from(dep);
    for (const effect of effects) {
        if (!effect.active) continue;
        if (effect.scheduler) {
            effect.scheduler();
        } else {
            runEffect(effect);
        }
    }
}

// ---------- signal (fonctionnel + closures) ----------

export function signal<
    T,
    R = Signal<T> & (T extends any[] ? ArraySourceMethods<T> : {})
>(initial: T): R {
    let current = initial;
    const target = {}; // pour tracking

    function read(): T {
        track(target);
        return current;
    }

    function write(value: T | ((p: T) => T)) {
        const next =
            typeof value === 'function'
                ? (value as (p: T) => T)(current)
                : value;

        if (Object.is(next, current)) return;
        current = next;
        trigger(target);
    }

    // Le callable est une fonction qui sert à la fois de "get" et "set"
    const fn = ((value?: any) => {
        if (value === undefined) return read();
        write(value);
    }) as Signal<T>;

    // API "classique" en bonus
    Object.defineProperties(fn, {
        value: {
            get: read,
            set: write,
        },
    });

    fn.set = write;
    fn.update = updater => write(updater);

    // Attache dynamiquement les méthodes type Array si la valeur est un tableau
    tryAttachArrayMethods(() => fn.value, fn);

    // Branding interne pour distinguer un signal d'autres valeurs/computed
    // Non-énumérable pour ne pas polluer l'API publique
    Object.defineProperty(fn, '__isSignal', {
        value: true,
        enumerable: false,
    });

    return fn as R;
}

// ---------- computed (read-only) ----------

export function computed<
    T,
    T2 extends ComputedGetter<T> | ComputedOptions<T>,
    T3 = T2 extends ComputedGetter<infer R> ? R : (T2 extends ComputedOptions<infer R2> ? R2 : T),
    R = (Computed<
        T3,
        T2 extends ComputedGetter<T> ? 'readonly' : 'writable'
    > & (T extends any[] ? ArraySourceMethods<T> : {}))
>(arg: T2): R {
    const isOptions = typeof arg === 'object';

    const getter: ComputedGetter<T> = isOptions
        ? (arg as ComputedOptions<T>).get
        : (arg as ComputedGetter<T>);

    const setter: ComputedSetter<T> | undefined = isOptions
        ? (arg as ComputedOptions<T>).set
        : undefined;

    let value!: T;
    let dirty = true;
    const target = {};

    const effect = createReactiveEffect(getter, () => {
        if (!dirty) {
            dirty = true;
            trigger(target); // notifie les watchers qui lisent ce computed
        }
    });

    const read = () => {
        track(target);
        if (dirty) {
            dirty = false;
            value = runEffect(effect);
        }
        return value;
    };

    if (!setter) {
        // --- readonly computed ---
        const fn = (() => read()) as CallableComputedReadonly<T>;

        Object.defineProperty(fn, 'value', {
            get: read,
        });

        // Attache dynamiquement les méthodes type Array si la valeur est un tableau
        tryAttachArrayMethods(read, fn);

        // Branding interne pour distinguer des signals
        Object.defineProperty(fn as any, '__isComputed', {
            value: 'readonly',
            enumerable: false,
        });

        return fn as unknown as R;
    }

    // --- writable computed ---
    const write = (v: T) => {
        setter(v);
    };

    const fn = ((value?: T) => {
        if (arguments.length === 0) {
            return read();
        }
        write(value as T);
    }) as CallableComputedWritable<T>;

    Object.defineProperty(fn, 'value', {
        get: read,
        set: write,
    });

    fn.set = write;

    // Attache dynamiquement les méthodes type Array si la valeur est un tableau
    tryAttachArrayMethods(read, fn);

    // Branding interne pour distinguer des signals
    Object.defineProperty(fn as any, '__isComputed', {
        value: 'writable',
        enumerable: false,
    });

    return fn as unknown as R;
}

// ---------- watchEffect ----------

export function watchEffect(
    effectFn: (onCleanup: OnCleanup) => void,
): StopHandle {
    let cleanup: CleanupFn | undefined;

    const runner = createReactiveEffect(
        () => {
            if (cleanup) {
                cleanup();
                cleanup = undefined;
            }

            const onCleanup: OnCleanup = (fn) => {
                cleanup = fn;
            };

            effectFn(onCleanup);
        },
        () => {
            runEffect(runner);
        },
    );

    runEffect(runner);

    return () => {
        if (cleanup) {
            cleanup();
            cleanup = undefined;
        }
        stopEffect(runner);
    };
}

// ---------- watch & watchOnce ----------

function normalizeWatchSource<T>(source: WatchSource<T>): () => T {
    if (typeof source === 'function') {
        return source as () => T;
    }
    return () => (source as SignalLike<T>).value;
}

export interface WatchOptions {
    immediate?: boolean;
}

export function watch<T>(
    source: WatchSource<T>,
    cb: (value: T, oldValue: T | undefined, onCleanup: OnCleanup) => void,
    options: WatchOptions = {},
): StopHandle {
    const getter = normalizeWatchSource(source);

    let oldValue: T | undefined;
    let initialized = false;
    let cleanup: CleanupFn | undefined;

    const onCleanup: OnCleanup = (fn) => {
        cleanup = fn;
    };

    let effect: ReactiveEffect<T>;

    const job = () => {
        if (!effect.active) return;

        const newValue = runEffect(effect);

        if (!initialized || !Object.is(newValue, oldValue)) {
            if (cleanup) {
                cleanup();
                cleanup = undefined;
            }

            cb(newValue, initialized ? oldValue : undefined, onCleanup);
            oldValue = newValue;
            initialized = true;
        }
    };

    effect = createReactiveEffect(getter, job);

    if (options.immediate) {
        job();
    } else {
        oldValue = runEffect(effect);
        initialized = true;
    }

    return () => {
        if (cleanup) {
            cleanup();
            cleanup = undefined;
        }
        stopEffect(effect);
    };
}

export function watchOnce<T>(
    source: WatchSource<T>,
    cb: (value: T, oldValue: T | undefined, onCleanup: OnCleanup) => void,
    options: WatchOptions = {},
): StopHandle {
    let stop: StopHandle = () => {};

    stop = watch(
        source,
        (value, oldValue, onCleanup) => {
            cb(value, oldValue, onCleanup);
            stop(); // se désabonne après la première exécution
        },
        options,
    );

    return stop;
}

// ---------- Helpers: Array iterators (map/filter/reduce) ----------

// mapArray
export function mapArray<T, U>(
    source: T[],
    mapper: (value: T, index: number, array: T[]) => U,
): U[];
export function mapArray<T, U>(
    source: WatchSource<T[]>,
    mapper: (value: T, index: number, array: T[]) => U,
): Computed<U[]>;
export function mapArray<T, U, R = U[] | Computed<U[]>>(
    source: T[] | WatchSource<T[]>,
    mapper: (value: T, index: number, array: T[]) => U,
): R {
    if (Array.isArray(source)) {
        return source.map(mapper) as R;
    }
    const getter = normalizeWatchSource(source as WatchSource<T[]>);
    return computed(() => getter().map(mapper)) as R;
}

// filterArray
export function filterArray<T>(
    source: T[],
    predicate: (value: T, index: number, array: T[]) => boolean,
): T[];
export function filterArray<T>(
    source: WatchSource<T[]>,
    predicate: (value: T, index: number, array: T[]) => boolean,
): Computed<T[]>;
export function filterArray<T, R = T[] | Computed<T[]>>(
    source: T[] | WatchSource<T[]>,
    predicate: (value: T, index: number, array: T[]) => boolean,
): R {
    if (Array.isArray(source)) {
        return source.filter(predicate) as R;
    }
    const getter = normalizeWatchSource(source as WatchSource<T[]>);
    return computed(() => getter().filter(predicate)) as R;
}

// reduceArray
export function reduceArray<T>(
    source: T[],
    reducer: (acc: T, value: T, index: number, array: T[]) => T,
): T;
export function reduceArray<T, R>(
    source: T[],
    reducer: (acc: R, value: T, index: number, array: T[]) => R,
    initialValue: R,
): R;
export function reduceArray<T>(
    source: WatchSource<T[]>,
    reducer: (acc: T, value: T, index: number, array: T[]) => T,
): Computed<T>;
export function reduceArray<T, R>(
    source: WatchSource<T[]>,
    reducer: (acc: R, value: T, index: number, array: T[]) => R,
    initialValue: R,
): Computed<R>;
export function reduceArray<T, R = T>(
    source: T[] | WatchSource<T[]>,
    reducer: (acc: any, value: T, index: number, array: T[]) => any,
    initialValue?: any,
): any {
    if (Array.isArray(source)) {
        if (arguments.length >= 3) {
            return (source as T[]).reduce(reducer as any, initialValue);
        }
        return (source as T[]).reduce(reducer as any);
    }
    const getter = normalizeWatchSource(source as WatchSource<T[]>);
    if (arguments.length >= 3) {
        return computed(() => getter().reduce(reducer as any, initialValue)) as Computed<R>;
    }
    return computed(() => getter().reduce(reducer as any)) as Computed<T>;
}

// ---------- Internal: attach array-like methods to reactive sources ----------

function tryAttachArrayMethods<T>(get: () => T, target: any): void {
    let value: unknown;
    try {
        value = get();
    } catch {
        // en cas d'accès hors tracking, on ignore et n'attache pas
        return;
    }
    if (!Array.isArray(value)) return;

    if (typeof target.map !== 'function') {
        Object.defineProperty(target, 'map', {
            value: (mapper: (v: any, i: number, a: any[]) => any) =>
                mapArray(target as unknown as WatchSource<any[]>, mapper),
            enumerable: false,
        });
    }
    if (typeof target.filter !== 'function') {
        Object.defineProperty(target, 'filter', {
            value: (predicate: (v: any, i: number, a: any[]) => boolean) =>
                filterArray(target as unknown as WatchSource<any[]>, predicate),
            enumerable: false,
        });
    }
    if (typeof target.reduce !== 'function') {
        Object.defineProperty(target, 'reduce', {
            value: (...args: any[]) => (reduceArray as any)(target as unknown as WatchSource<any[]>, ...args),
            enumerable: false,
        });
    }
}

import {computed, signal} from "../lib/signals";
import {html} from "../lib/components";

export function Counter<T extends { label: string }>(props: T) {
    const count = signal(0);
    const double = computed(() => count() * 2);

    const handleClick = () => count.set(c => c + 1);
    const handleRightClick = (e: MouseEvent) => {
        e.preventDefault();
        count.set(c => c - 1);
    };

    return () => html`<div class="card">
        <button type="button" onclick="${handleClick}" oncontextmenu="${handleRightClick}">
            ${props.label}: ${count} (x2: ${double})
        </button>
    </div>`;
}
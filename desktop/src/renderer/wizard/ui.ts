import { h } from "../dom.js";

export const fmtDuration = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

export const fmtMinutes = (sec: number) => `${Math.floor(sec / 60)} min ${String(Math.floor(sec % 60)).padStart(2, "0")} s`;

export function callout(kind: "info" | "warn" | "error" | "ok", ...children: (Node | string | null)[]) {
  return h("div", { class: `callout ${kind}`, role: kind === "error" ? "alert" : "note" }, ...children);
}

export function section(title: string, ...children: (Node | string | null | undefined | false)[]) {
  return h("section", { class: "panel" }, h("h3", {}, title), ...children);
}

export function steps(items: string[]) {
  return h("ol", { class: "how" }, ...items.map((t) => h("li", {}, t)));
}

export function field(label: string, control: HTMLElement, hint?: string) {
  return h("label", { class: "field" }, h("span", {}, label), control, hint ? h("small", { class: "muted" }, hint) : null);
}

export function progressBar(fraction: number, label?: string, id?: string) {
  const pct = Math.max(0, Math.min(1, fraction));
  return h(
    "div",
    { class: "bar-wrap", id },
    h("div", { class: "bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(pct * 100) }, h("div", { class: "bar-fill", style: `width:${pct * 100}%` })),
    label ? h("span", { class: "muted" }, label) : null,
  );
}

export async function copyText(text: string, source?: HTMLTextAreaElement | HTMLInputElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!source) return false;
    source.select();
    return document.execCommand?.("copy") ?? false;
  }
}

/** Runs an async action while its button is disabled, reporting failures through `say`. */
export async function busy(button: HTMLButtonElement, say: (m: string) => void, run: () => Promise<void>, errorText: (e: unknown) => string) {
  button.disabled = true;
  try {
    await run();
  } catch (err) {
    say(errorText(err));
  } finally {
    button.disabled = false;
  }
}

import { h, $ } from "./dom.js";

let statusTimer = null;

export function toast(message, variant = "info", timeout = 3500) {
  const container = $("#toasts");
  if (!container) return;
  const el = h("div", { class: `toast toast-${variant}`, role: variant === "error" ? "alert" : "status" }, message);
  container.append(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, timeout);
}

export function setStatus(message, variant = "info") {
  const el = $("#statusText");
  if (!el) return;
  el.textContent = message;
  el.dataset.variant = variant;
  clearTimeout(statusTimer);
  if (variant !== "error") statusTimer = setTimeout(() => { el.dataset.variant = "idle"; }, 4000);
}

export function reportError(context, error, userMessage) {
  console.error(`[${context}]`, error);
  const detail = error && error.message ? ` (${error.message})` : "";
  toast(`${userMessage || context}${detail}`, "error", 5500);
  setStatus(userMessage || `${context} failed`, "error");
}

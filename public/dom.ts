type Child = Node | string | number | boolean | null | undefined;

interface ElementOptions {
  className?: string;
  id?: string;
  type?: string;
  text?: unknown;
  attrs?: Record<string, unknown>;
  dataset?: Record<string, unknown>;
}

export function el<K extends keyof HTMLElementTagNameMap>(tagName: K, options: ElementOptions = {}, ...children: unknown[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  applyOptions(node, options);
  appendChildren(node, children);
  return node;
}

export function textEl<K extends keyof HTMLElementTagNameMap>(tagName: K, text: unknown, options: ElementOptions = {}): HTMLElementTagNameMap[K] {
  return el(tagName, options, String(text ?? ""));
}

export function appendChildren<T extends HTMLElement>(parent: T, children: unknown[]): T {
  for (const child of children.flat(Infinity) as Child[]) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function detailBlock(title: unknown, detail: unknown): HTMLDivElement {
  return el("div", {}, textEl("strong", title), textEl("span", detail));
}

export function progressBlock(title: unknown, detail: unknown, percent: number): HTMLDivElement {
  const fill = el("div");
  fill.style.width = `${percent}%`;
  return el(
    "div",
    {},
    textEl("strong", title),
    textEl("span", detail),
    el("div", { className: "limit-progress" }, fill)
  );
}

export function dayCheckbox(value: unknown, label: unknown, { checked = true }: { checked?: boolean } = {}): HTMLLabelElement {
  const input = el("input", {
    attrs: {
      type: "checkbox",
      value
    }
  });
  input.checked = checked;
  return el("label", {}, input, textEl("span", label));
}

function applyOptions(node: HTMLElement, options: ElementOptions): void {
  if (options.className) node.className = options.className;
  if (options.id) node.id = options.id;
  if (options.type && "type" in node) (node as HTMLInputElement | HTMLButtonElement).type = options.type;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value === false || value === null || value === undefined) continue;
      node.setAttribute(name, value === true ? "" : String(value));
    }
  }
  if (options.dataset) {
    for (const [name, value] of Object.entries(options.dataset)) {
      node.dataset[name] = String(value);
    }
  }
}

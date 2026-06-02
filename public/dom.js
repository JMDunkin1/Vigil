export function el(tagName, options = {}, ...children) {
  const node = document.createElement(tagName);
  applyOptions(node, options);
  appendChildren(node, children);
  return node;
}

export function textEl(tagName, text, options = {}) {
  return el(tagName, options, text);
}

export function appendChildren(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function detailBlock(title, detail) {
  return el("div", {}, textEl("strong", title), textEl("span", detail));
}

export function progressBlock(title, detail, percent) {
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

export function dayCheckbox(value, label, { checked = true } = {}) {
  const input = el("input", {
    attrs: {
      type: "checkbox",
      value
    }
  });
  input.checked = checked;
  return el("label", {}, input, textEl("span", label));
}

function applyOptions(node, options) {
  if (options.className) node.className = options.className;
  if (options.id) node.id = options.id;
  if (options.type) node.type = options.type;
  if (options.text !== undefined) node.textContent = options.text;
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

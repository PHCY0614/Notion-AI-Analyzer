(function attachAnalyzerSelect(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AnalyzerSelect = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createAnalyzerSelect() {
  "use strict";

  function enhance(select, options = {}) {
    const extraRootClass = options.extraRootClass || "";
    const emptyLabel = options.emptyLabel || "請選擇";
    const matchNativeState = options.matchNativeState === true;
    const attachDocumentListeners = options.attachDocumentListeners === true;
    const onToggle = options.onToggle;

    const root = document.createElement("div");
    root.className = extraRootClass ? `custom-select ${extraRootClass}` : "custom-select";
    select.before(root);
    root.append(select);
    select.classList.add("custom-select__native");

    const trigger = document.createElement("button");
    trigger.id = `${select.id}-trigger`;
    trigger.className = "custom-select__trigger";
    trigger.type = "button";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    const value = document.createElement("span");
    value.className = "custom-select__value";
    const arrow = document.createElement("span");
    arrow.className = "custom-select__arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "⌄";
    trigger.append(value, arrow);

    const menu = document.createElement("div");
    menu.id = `${select.id}-menu`;
    menu.className = "custom-select__menu";
    menu.role = "listbox";
    menu.hidden = true;
    trigger.setAttribute("aria-controls", menu.id);
    root.append(trigger, menu);

    const originalLabel = document.querySelector(`label[for="${select.id}"]`);
    if (originalLabel) originalLabel.htmlFor = trigger.id;

    const controller = {
      close() {
        menu.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      },
      sync() {
        if (matchNativeState) root.hidden = select.hidden;
        const selected = select.selectedOptions[0];
        value.textContent = selected?.textContent || emptyLabel;
        value.title = value.textContent;
        trigger.disabled = select.disabled || select.options.length === 0;
        menu.replaceChildren(...[...select.options].map(option => {
          const item = document.createElement("button");
          item.className = "custom-select__option";
          item.type = "button";
          item.role = "option";
          item.dataset.value = option.value;
          if (matchNativeState) item.disabled = option.disabled;
          item.setAttribute("aria-selected", String(option.selected));
          const check = document.createElement("span");
          check.className = `custom-select__check${option.selected ? "" : " custom-select__check--empty"}`;
          check.setAttribute("aria-hidden", "true");
          check.textContent = "✓";
          const label = document.createElement("span");
          label.textContent = option.textContent;
          item.append(check, label);
          item.addEventListener("click", () => {
            select.value = option.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            controller.sync();
            controller.close();
            trigger.focus();
          });
          return item;
        }));
      }
    };
    trigger.addEventListener("click", () => {
      const opening = menu.hidden;
      if (typeof onToggle === "function") onToggle(controller, opening);
      menu.hidden = !opening;
      trigger.setAttribute("aria-expanded", String(opening));
    });
    if (attachDocumentListeners) {
      document.addEventListener("mousedown", event => {
        if (!root.contains(event.target)) controller.close();
      });
      document.addEventListener("keydown", event => {
        if (event.key === "Escape") controller.close();
      });
    }
    new MutationObserver(() => controller.sync()).observe(select, {
      attributes: true,
      childList: true,
      subtree: true
    });
    controller.sync();
    return controller;
  }

  return Object.freeze({ enhance });
});

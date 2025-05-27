// @updateURL    https://github.com/nkd89/a11y-userscript/raw/refs/heads/main/a11y-debugger.user.js
// @downloadURL  https://github.com/nkd89/a11y-userscript/raw/refs/heads/main/a11y-debugger.user.js
// ==UserScript==
// @name         Отладка Доступности WEB-приложений
// @namespace    http://tampermonkey.net/
// @version      0.6
// @description  Помогает эффективно выявлять проблемы доступности в веб-приложениях, учитывая динамическое содержимое и имитируя чтение скринридеров. Добавлены механизмы отладки и улучшена стабильность.
// @author       Nikita Pankin (@izvenyaisya)
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
  "use strict";

  // --- Стили для визуальных подсказок ---
  GM_addStyle(`
      .a11y-debug-focusable {
          outline: 2px dashed #1e90ff !important;
          box-shadow: 0 0 0 2px rgba(30, 144, 255, 0.2) !important;
          cursor: pointer !important;
      }
      .a11y-debug-no-alt {
          outline: 3px solid orange !important;
          background-color: rgba(255, 165, 0, 0.1) !important;
          cursor: pointer !important;
      }
      .a11y-debug-no-accessible-name {
          outline: 3px solid red !important;
          background-color: rgba(255, 0, 0, 0.1) !important;
          cursor: pointer !important;
      }
      .a11y-debug-high-contrast-mode {
          filter: grayscale(100%) contrast(200%) !important;
          -webkit-filter: grayscale(100%) contrast(200%) !important;
      }
      #a11y-debug-panel {
          position: fixed;
          top: 10px;
          right: 10px;
          background-color: rgba(0,0,0,0.8);
          padding: 10px;
          color: #fff;
          z-index: 99999;
          border-radius: 5px;
          font-family: sans-serif;
          font-size: 13px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          max-width: 200px;
          box-sizing: border-box;
      }
      #a11y-debug-panel label {
          display: flex;
          align-items: center;
          cursor: pointer;
      }
      #a11y-debug-panel input[type="checkbox"] {
          margin-right: 8px;
          cursor: pointer;
          appearance: auto;
          width: 16px;
          height: 16px;
          accent-color: black;
      }
      #a11y-debug-panel hr {
          border: none;
          border-top: 1px solid rgba(255, 255, 255, 0.3);
          margin: 5px 0;
      }

      .a11y-debug-screenreader-info {
          position: absolute;
          background-color: #000;
          color: #fff;
          border: 1px solid #1e90ff;
          padding: 8px;
          border-radius: 4px;
          font-family: monospace;
          font-size: 12px;
          white-space: pre-wrap;
          z-index: 100000;
          pointer-events: none;
          box-shadow: 2px 2px 5px rgba(0,0,0,0.3);
          max-width: 300px;
          box-sizing: border-box;
          text-align: left;
      }
      .a11y-debug-screenreader-info strong {
          color: #add8e6;
      }
  `);

  // --- Глобальные переменные ---
  let currentScreenreaderInfoElement = null;
  let screenreaderInfoEnabled = false;
  let debounceTimer; // Для MutationObserver

  // --- Вспомогательные функции ---

  /**
   * Вычисляет доступное имя элемента. Поддерживает несколько ID в aria-labelledby.
   * @param {HTMLElement} element
   * @returns {string} Доступное имя.
   */
  function getAccessibleName(element) {
    if (!element || !element.hasAttribute) return "";

    // 1. aria-labelledby (несколько ID)
    if (element.hasAttribute("aria-labelledby")) {
      const ids = element.getAttribute("aria-labelledby").split(/\s+/);
      let labelledTexts = [];
      ids.forEach((id) => {
        const labelledByElement = document.getElementById(id);
        if (
          labelledByElement &&
          labelledByElement.textContent.trim().length > 0
        ) {
          labelledTexts.push(labelledByElement.textContent.trim());
        }
      });
      if (labelledTexts.length > 0) return labelledTexts.join(" ");
    }
    // 2. aria-label
    if (
      element.hasAttribute("aria-label") &&
      typeof element.getAttribute("aria-label") === "string" &&
      element.getAttribute("aria-label").trim().length > 0
    ) {
      return element.getAttribute("aria-label").trim();
    }
    // 3. Для input, textarea, select, связанных с label
    if (
      (element.tagName === "INPUT" ||
        element.tagName === "TEXTAREA" ||
        element.tagName === "SELECT") &&
      element.id
    ) {
      const label = document.querySelector(`label[for="${element.id}"]`);
      if (
        label &&
        typeof label.textContent === "string" &&
        label.textContent.trim().length > 0
      ) {
        return label.textContent.trim();
      }
    }
    // 4. Для img
    if (
      element.tagName === "IMG" &&
      element.hasAttribute("alt") &&
      typeof element.getAttribute("alt") === "string" &&
      element.getAttribute("alt").trim().length > 0
    ) {
      return element.getAttribute("alt").trim();
    }
    // 5. Для input type="submit", "button", "reset"
    if (
      element.tagName === "INPUT" &&
      (element.type === "submit" ||
        element.type === "button" ||
        element.type === "reset") &&
      element.hasAttribute("value") &&
      typeof element.getAttribute("value") === "string" &&
      element.getAttribute("value").trim().length > 0
    ) {
      return element.getAttribute("value").trim();
    }
    // 6. Для button, a, summary (текстовое содержимое)
    if (
      ["BUTTON", "A", "SUMMARY"].includes(element.tagName) &&
      typeof element.textContent === "string" &&
      element.textContent.trim().length > 0
    ) {
      return element.textContent.trim();
    }
    // 7. title атрибут (как последнее средство)
    if (
      element.hasAttribute("title") &&
      typeof element.getAttribute("title") === "string" &&
      element.getAttribute("title").trim().length > 0
    ) {
      return element.getAttribute("title").trim();
    }
    return "";
  }

  /**
   * Вычисляет роль элемента.
   * @param {HTMLElement} element
   * @returns {string} Роль элемента.
   */
  function getAccessibleRole(element) {
    if (!element || !element.hasAttribute) return "generic";

    if (element.hasAttribute("role")) {
      return element.getAttribute("role");
    }
    // Семантические роли по умолчанию для HTML5 элементов
    if (element.tagName === "A" && element.hasAttribute("href")) return "link";
    if (element.tagName === "BUTTON") return "button";
    if (element.tagName === "INPUT") {
      const type = element.type;
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (
        [
          "text",
          "email",
          "password",
          "search",
          "tel",
          "url",
          "number",
        ].includes(type)
      )
        return "textbox";
      if (["submit", "reset", "button"].includes(type)) return "button";
    }
    if (element.tagName === "SELECT") return "combobox";
    if (element.tagName === "TEXTAREA") return "textbox";
    if (element.tagName === "IMG") return "img";
    if (
      element.tagName.startsWith("H") &&
      element.tagName.length === 2 &&
      parseInt(element.tagName[1]) >= 1 &&
      parseInt(element.tagName[1]) <= 6
    )
      return "heading";
    if (element.tagName === "UL" || element.tagName === "OL") return "list";
    if (element.tagName === "LI") return "listitem";
    if (element.tagName === "NAV") return "navigation";
    if (element.tagName === "MAIN") return "main";
    if (element.tagName === "HEADER") return "banner";
    if (element.tagName === "FOOTER") return "contentinfo";
    if (element.tagName === "FORM") return "form";
    if (element.tagName === "SECTION") return "region";
    if (element.tagName === "ASIDE") return "complementary";
    if (element.tagName === "DIALOG") return "dialog";
    if (element.tagName === "DETAILS") return "group";
    if (element.tagName === "SUMMARY") return "button";
    if (element.tagName === "TABLE") return "table";
    if (element.tagName === "TH") return "columnheader";
    if (element.tagName === "TD") return "cell";
    return "generic";
  }

  /**
   * Вычисляет состояния и свойства элемента.
   * @param {HTMLElement} element
   * @returns {string[]} Массив строк с состояниями.
   */
  function getAccessibleStateAndProperties(element) {
    if (!element || !element.hasAttribute) return [];

    const states = [];

    Array.from(element.attributes)
      .filter((attr) => attr.name.startsWith("aria-"))
      .forEach((attr) => states.push(`${attr.name}: ${attr.value}`));

    if (element.hasAttribute("hidden") && element.hidden)
      states.push("hidden: true");
    if (element.hasAttribute("disabled")) states.push("disabled: true");
    if (element.hasAttribute("required")) states.push("required: true");
    if (
      element.tagName === "INPUT" &&
      element.type === "checkbox" &&
      element.checked
    )
      states.push("checked: true");
    else if (
      element.tagName === "INPUT" &&
      element.type === "checkbox" &&
      !element.checked
    )
      states.push("checked: false");

    if (
      element.tagName === "INPUT" &&
      element.type === "radio" &&
      element.checked
    )
      states.push("checked: true");
    else if (
      element.tagName === "INPUT" &&
      element.type === "radio" &&
      !element.checked
    )
      states.push("checked: false");

    if (element.tagName === "OPTION" && element.selected)
      states.push("selected: true");
    else if (element.tagName === "OPTION" && !element.selected)
      states.push("selected: false");

    if (element.tagName === "DETAILS" && element.open)
      states.push("expanded: true");
    else if (element.tagName === "DETAILS" && !element.open)
      states.push("expanded: false");

    if (element.hasAttribute("aria-expanded"))
      states.push(`aria-expanded: ${element.getAttribute("aria-expanded")}`);
    if (element.hasAttribute("aria-pressed"))
      states.push(`aria-pressed: ${element.getAttribute("aria-pressed")}`);
    if (element.hasAttribute("aria-current"))
      states.push(`aria-current: ${element.getAttribute("aria-current")}`);
    if (element.hasAttribute("aria-selected"))
      states.push(`aria-selected: ${element.getAttribute("aria-selected")}`);
    if (element.hasAttribute("aria-checked"))
      states.push(`aria-checked: ${element.getAttribute("aria-checked")}`);
    if (element.hasAttribute("aria-invalid"))
      states.push(`aria-invalid: ${element.getAttribute("aria-invalid")}`);
    if (element.hasAttribute("aria-disabled"))
      states.push(`aria-disabled: ${element.getAttribute("aria-disabled")}`);

    return states;
  }

  /**
   * Отображает информацию скринридера для элемента.
   * @param {HTMLElement} element
   */
  function showScreenreaderInfo(element) {
    if (!screenreaderInfoEnabled) return;
    if (!element || !element.nodeType || element.nodeType !== 1) return;

    if (currentScreenreaderInfoElement) {
      currentScreenreaderInfoElement.remove();
    }

    const name = getAccessibleName(element);
    const role = getAccessibleRole(element);
    const states = getAccessibleStateAndProperties(element);

    let infoText = `<strong>Элемент:</strong> &lt;${element.tagName.toLowerCase()}&gt; (id: ${
      element.id || "нет"
    })\n`;
    infoText += `<strong>Роль:</strong> ${role || "generic"}\n`;
    infoText += `<strong>Имя:</strong> ${
      name || '<span style="color:red;">НЕТ ИМЕНИ!</span>'
    }\n`;

    if (states.length > 0) {
      infoText += `<strong>Состояния/Свойства:</strong>\n- ${states.join(
        "\n- "
      )}`;
    } else {
      infoText += `<strong>Состояния/Свойства:</strong> Нет`;
    }

    const infoDiv = document.createElement("div");
    infoDiv.className = "a11y-debug-screenreader-info";
    infoDiv.innerHTML = infoText;

    document.body.appendChild(infoDiv);
    currentScreenreaderInfoElement = infoDiv;

    const rect = element.getBoundingClientRect();
    const infoRect = infoDiv.getBoundingClientRect();
    let top = rect.bottom + window.scrollY + 5;
    let left = rect.left + window.scrollX;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (
      left + infoRect.width + 10 > viewportWidth + window.scrollX &&
      left - infoRect.width - 10 > window.scrollX
    ) {
      left = rect.left + window.scrollX - infoRect.width - 10;
    } else if (left + infoRect.width + 10 > viewportWidth + window.scrollX) {
      left = viewportWidth + window.scrollX - infoRect.width - 10;
    }
    if (left < window.scrollX) {
      left = window.scrollX + 10;
    }

    if (top + infoRect.height > viewportHeight + window.scrollY) {
      top = rect.top + window.scrollY - infoRect.height - 5;
      if (top < window.scrollY) {
        top = window.scrollY + 10;
      }
    }

    infoDiv.style.top = `${top}px`;
    infoDiv.style.left = `${left}px`;
  }

  /**
   * Скрывает информацию скринридера.
   */
  function hideScreenreaderInfo() {
    if (currentScreenreaderInfoElement) {
      currentScreenreaderInfoElement.remove();
      currentScreenreaderInfoElement = null;
    }
  }

  // --- Обработчики событий для клика по подсвеченным элементам ---
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (
      target.classList.contains("a11y-debug-no-accessible-name") ||
      target.classList.contains("a11y-debug-no-alt") ||
      target.classList.contains("a11y-debug-focusable")
    ) {
      target.classList.remove(
        "a11y-debug-no-accessible-name",
        "a11y-debug-no-alt",
        "a11y-debug-focusable"
      );
      hideScreenreaderInfo();
    }
  });

  // --- Функции активации/деактивации фич ---

  function toggleFocusableHighlight(enable) {
    const interactiveElements = document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, ' +
        '[tabindex]:not([tabindex="-1"]), ' +
        '[role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
        '[role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"], ' +
        '[role="tab"], [role="menuitem"], [role="option"], [role="switch"], [contenteditable="true"]'
    );

    interactiveElements.forEach((el) => {
      if (el.closest('[aria-hidden="true"]')) {
        el.classList.remove("a11y-debug-focusable");
        return;
      }
      el.classList.toggle("a11y-debug-focusable", enable);
      if (enable && screenreaderInfoEnabled) {
        el.addEventListener("mouseover", handleElementMouseOver);
        el.addEventListener("mouseout", handleElementMouseOut);
      } else {
        el.removeEventListener("mouseover", handleElementMouseOver);
        el.removeEventListener("mouseout", handleElementMouseOut);
      }
    });
    if (!enable) {
      hideScreenreaderInfo();
    }
  }

  function handleElementMouseOver(event) {
    try {
      showScreenreaderInfo(event.currentTarget);
    } catch (e) {
      console.error(
        "Tampermonkey A11y Debugger: Error showing screenreader info",
        e
      );
    }
  }

  function handleElementMouseOut() {
    hideScreenreaderInfo();
  }

  function toggleImagesWithoutAltHighlight(enable) {
    document.querySelectorAll('img:not([alt]), img[alt=""]').forEach((el) => {
      if (el.closest('[aria-hidden="true"]')) {
        el.classList.remove("a11y-debug-no-alt");
        return;
      }
      el.classList.toggle("a11y-debug-no-alt", enable);
    });
  }

  function toggleNoAccessibleNameHighlight(enable) {
    const elementsToCheck = document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, ' +
        '[role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="textbox"], ' +
        '[role="combobox"], [role="slider"], [role="tab"], [role="menuitem"], [role="option"], ' +
        '[role="heading"], [role="img"], [role="form"], [role="group"], [role="region"], ' +
        '[tabindex]:not([tabindex="-1"])'
    );

    elementsToCheck.forEach((el) => {
      if (el.closest('[aria-hidden="true"]')) {
        el.classList.remove("a11y-debug-no-accessible-name");
        return;
      }

      const hasName = getAccessibleName(el);
      const isDecorativeImage =
        el.tagName === "IMG" && el.getAttribute("alt") === "";
      const isPartofNamedComponent =
        el.closest("[aria-labelledby], [aria-label]") &&
        !["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "IMG"].includes(
          el.tagName
        );

      if (isDecorativeImage || hasName || isPartofNamedComponent) {
        el.classList.remove("a11y-debug-no-accessible-name");
      } else {
        el.classList.toggle("a11y-debug-no-accessible-name", enable);
      }
    });
  }

  function toggleHighContrastMode(enable) {
    if (document.documentElement) {
      document.documentElement.classList.toggle(
        "a11y-debug-high-contrast-mode",
        enable
      );
    } else {
      console.warn(
        "Tampermonkey A11y Debugger: document.documentElement not found for high contrast mode."
      );
    }
  }

  function toggleScreenreaderInfo(enable) {
    screenreaderInfoEnabled = enable;
    if (!enable) {
      hideScreenreaderInfo();
    }
    toggleFocusableHighlight(featureStates["a11yDebug_focusable"]);
  }

  // --- Панель управления ---

  function createControlPanel() {
    const panel = document.createElement("div");
    panel.id = "a11y-debug-panel";

    const features = [
      {
        label: "Подсветить фокусируемые",
        action: toggleFocusableHighlight,
        key: "a11yDebug_focusable",
      },
      {
        label: "Изображения без alt",
        action: toggleImagesWithoutAltHighlight,
        key: "a11yDebug_noAlt",
      },
      {
        label: "Элементы без доступного имени",
        action: toggleNoAccessibleNameHighlight,
        key: "a11yDebug_noAccessibleName",
      },
      {
        label: "Высокая контрастность",
        action: toggleHighContrastMode,
        key: "a11yDebug_highContrast",
      },
      {
        label: "Инфо скринридера (наведение)",
        action: toggleScreenreaderInfo,
        key: "a11yDebug_screenreaderInfo",
      },
    ];

    features.forEach((feat) => {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = `a11y-debug-checkbox-${feat.key}`;
      checkbox.checked = GM_getValue(feat.key, false);

      const label = document.createElement("label");
      label.htmlFor = checkbox.id;
      label.textContent = feat.label;
      label.prepend(checkbox);

      checkbox.addEventListener("change", (e) => {
        featureStates[feat.key] = e.target.checked;
        GM_setValue(feat.key, e.target.checked);
        applyActiveFeatures();
      });

      panel.appendChild(label);
    });

    document.body.appendChild(panel);
  }

  // --- Инициализация и MutationObserver ---

  const featureStates = {
    a11yDebug_focusable: false,
    a11yDebug_noAlt: false,
    a11yDebug_noAccessibleName: false,
    a11yDebug_highContrast: false,
    a11yDebug_screenreaderInfo: false,
  };

  for (const key in featureStates) {
    featureStates[key] = GM_getValue(key, false);
  }

  function applyActiveFeatures() {
    try {
      toggleFocusableHighlight(featureStates["a11yDebug_focusable"]);
      toggleImagesWithoutAltHighlight(featureStates["a11yDebug_noAlt"]);
      toggleNoAccessibleNameHighlight(
        featureStates["a11yDebug_noAccessibleName"]
      );
      toggleHighContrastMode(featureStates["a11yDebug_highContrast"]);
      toggleScreenreaderInfo(featureStates["a11yDebug_screenreaderInfo"]);
    } catch (e) {
      console.error("Tampermonkey A11y Debugger: Error applying features", e);
    }
  }

  window.addEventListener("load", () => {
    try {
      createControlPanel();
      applyActiveFeatures();
    } catch (e) {
      console.error("Tampermonkey A11y Debugger: Error during initial load", e);
    }
  });

  const observer = new MutationObserver((mutationsList) => {
    let relevantMutation = false;
    for (const mutation of mutationsList) {
      if (
        mutation.type === "childList" ||
        (mutation.type === "attributes" &&
          [
            "class",
            "id",
            "role",
            "tabindex",
            "alt",
            "aria-label",
            "aria-labelledby",
            "title",
            "value",
            "for",
            "hidden",
            "disabled",
            "checked",
            "selected",
            "open",
            "aria-expanded",
            "aria-pressed",
            "aria-current",
            "aria-selected",
            "aria-checked",
            "aria-invalid",
            "aria-disabled",
          ].includes(mutation.attributeName))
      ) {
        relevantMutation = true;
        break;
      }
    }
    if (relevantMutation) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        applyActiveFeatures();
      }, 50);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "class",
      "id",
      "role",
      "tabindex",
      "alt",
      "aria-label",
      "aria-labelledby",
      "title",
      "value",
      "for",
      "hidden",
      "disabled",
      "checked",
      "selected",
      "open",
      "aria-expanded",
      "aria-pressed",
      "aria-current",
      "aria-selected",
      "aria-checked",
      "aria-invalid",
      "aria-disabled",
    ],
  });
})();

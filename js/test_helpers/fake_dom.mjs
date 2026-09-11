/*
 * Faux DOM minimal PARTAGÉ (js/test_helpers/fake_dom.mjs).
 *
 * Extrait de js/test_aih_dialog.mjs pour être importé EXPLICITEMENT par les
 * tests qui en dépendent (test_aih_dialog.mjs, test_aih_window_manager.mjs).
 * Aucun découpage par marqueur texte n'est plus nécessaire : un renommage de
 * commentaire ne peut donc plus provoquer un import silencieusement incomplet.
 *
 * À l'import, le module installe window/document/localStorage/getComputedStyle
 * sur globalThis et exporte le fake document (et ses classes) pour les tests
 * qui inspectent le DOM directement.
 */
/* ──────────────────────────── Fake DOM minimal ──────────────────────────── */

function splitAttrs(str) {
    const attrs = {};
    const re = /([\w-]+)(?:="([^"]*)")?/g;
    let m;
    while ((m = re.exec(str))) attrs[m[1]] = m[2] !== undefined ? m[2] : "";
    return attrs;
}

// Parse un HTML simple (div/span/button/input + texte) en sous-éléments.
function parseHTML(html) {
    const root = new FakeEl("div");
    const stack = [root];
    const tagRe = /<(\/)?([a-zA-Z0-9]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
    let m;
    while ((m = tagRe.exec(html))) {
        if (m[5] !== undefined) {
            // Texte
            if (m[5].trim()) stack[stack.length - 1].children.push(new FakeText(m[5]));
        } else if (m[1]) {
            stack.pop();
        } else {
            const el = new FakeEl(m[2]);
            Object.assign(el._attrs, splitAttrs(m[3] || ""));
            const closing = m[4] === "/";
            stack[stack.length - 1].children.push(el);
            el._parent = stack[stack.length - 1];
            if (!closing) stack.push(el);
        }
    }
    return root.children;
}

class FakeText {
    constructor(text) { this.nodeType = 3; this.textContent = text; }
    get className() { return ""; }
}

class FakeEl {
    constructor(tag) {
        this.tagName = (tag || "div").toUpperCase();
        this.nodeType = 1;
        this.children = [];
        this._attrs = {};
        this._listeners = {};
        this.dataset = {};
        this.style = new FakeStyle();
        this.classList = new FakeClassList(this);
        this.id = "";
        this.value = "";
        this.focus = () => {};
        this.blur = () => {};
        this.textContent = "";
        this._innerHTML = "";
        this.parentNode = null;
        this.offsetWidth = 400;
        this.offsetHeight = 300;
        this.offsetLeft = 0;
        this.offsetTop = 0;
    }
    get className() {
        return this._className || "";
    }
    set className(v) {
        this._className = v || "";
        this._classList = this._className.split(/\s+/).filter(Boolean);
    }
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === "class") this.className = v; if (k === "id") this.id = v; }
    getAttribute(k) { return this._attrs[k] !== undefined ? this._attrs[k] : null; }
    set innerHTML(v) {
        this._innerHTML = v || "";
        this.children = [];
        parseHTML(this._innerHTML).forEach((c) => { c._parent = this; this.children.push(c); });
    }
    get innerHTML() { return this._innerHTML; }
    appendChild(c) { if (c._parent) c._parent._removeChild(c); c._parent = this; c.parentNode = this; this.children.push(c); return c; }
    insertBefore(newNode, refNode) { if (refNode && this.children.indexOf(refNode) >= 0) { if (newNode._parent) newNode._parent._removeChild(newNode); newNode._parent = this; newNode.parentNode = this; this.children.splice(this.children.indexOf(refNode), 0, newNode); } else { this.appendChild(newNode); } return newNode; }
    append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
    _removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c._parent = null; c.parentNode = null; }
    remove() { if (this._parent) this._parent._removeChild(this); }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    removeEventListener(type, fn) {
        const arr = this._listeners[type] || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
    }
    dispatch(type, ev) {
        const arr = (this._listeners[type] || []).slice();
        for (const fn of arr) fn(ev);
    }
    _matches(sel) {
        // Supporte : tag, .class, #id, [attr], [attr=value], combinaisons
        if (!sel) return false;
        const parts = sel.split(/\s+/).filter(Boolean);
        let cur = this;
        for (const p of parts) {
            if (p === ">") continue;
            if (p.includes(",")) {
                // non géré
            }
        }
        // Sélecteur composé (ex: div.aih-dialog-busy-msg, [data-aih-ok], #id)
        let node = this;
        for (const tok of sel.split(/\s+/).filter(Boolean)) {
            const isChild = tok === ">";
            if (isChild) continue;
            // match un seul nœud descendant
        }
        // simple compound selector
        const re = /^([a-zA-Z0-9]+)?((?:\.([\w-]+))|(?:#([\w-]+))|(?:\[([\w-]+)(?:=([^\]]+))?\]))*$/;
        const m = re.exec(sel);
        if (!m) {
            // descendant combinators non gérés → on cherche simplement par le dernier token
            return this._matchCompound(sel.split(/\s+/).pop());
        }
        return this._matchCompound(sel);
    }
    _matchCompound(sel) {
        const re = /^([a-zA-Z0-9]+)?((?:\.([\w-]+))|(?:#([\w-]+))|(?:\[([\w-]+)(?:=([^\]]+))?\]))*$/;
        const m = re.exec(sel);
        if (!m) return false;
        const tag = m[1];
        if (tag && tag.toLowerCase() !== this.tagName.toLowerCase()) return false;
        let rest = m[2] || "";
        const clsRe = /\.([\w-]+)/g;
        let cm;
        const tags = [];
        while ((cm = clsRe.exec(rest))) {
            if (!this.classList.contains(cm[1])) return false;
        }
        if (this.id && sel.includes("#")) {
            const idM = /#([\w-]+)/.exec(sel);
            if (idM && this.id !== idM[1]) return false;
        }
        const attrRe = /\[([\w-]+)(?:=([^\]]+))?\]/g;
        let am;
        while ((am = attrRe.exec(rest))) {
            const name = am[1];
            const expected = am[2];
            if (expected !== undefined) {
                const v = this._attrs[name];
                const exp = expected.replace(/^["']|["']$/g, "");
                if (v !== exp) return false;
            } else if (!(name in this._attrs)) {
                return false;
            }
        }
        return true;
    }
    _allDescendants(out) {
        for (const c of this.children) {
            if (c.nodeType === 1) { out.push(c); c._allDescendants(out); }
        }
        return out;
    }
    querySelectorAll(sel) {
        return this._allDescendants([]).filter((n) => n._matches(sel));
    }
    querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
    }
    getBoundingClientRect() {
        return { left: this.offsetLeft, top: this.offsetTop, width: this.offsetWidth, height: this.offsetHeight, right: this.offsetLeft + this.offsetWidth, bottom: this.offsetTop + this.offsetHeight };
    }
    contains(node) {
        let n = node;
        while (n) { if (n === this) return true; n = n._parent; }
        return false;
    }
    closest(sel) {
        let n = this;
        while (n) { if (n._matches && n._matches(sel)) return n; n = n._parent; }
        return null;
    }
}

class FakeClassList {
    constructor(el) { this._el = el; }
    _arr() { return (this._el._classList = this._el._classList || (this._el.className ? this._el.className.split(/\s+/).filter(Boolean) : [])); }
    contains(c) { return this._arr().includes(c); }
    add(...cs) { cs.forEach((c) => { if (!this._arr().includes(c)) this._arr().push(c); }); this._sync(); }
    remove(...cs) { cs.forEach((c) => { const i = this._arr().indexOf(c); if (i >= 0) this._arr().splice(i, 1); }); this._sync(); }
    toggle(c) { if (this.contains(c)) this.remove(c); else this.add(c); return this.contains(c); }
    _sync() { this._el._className = this._arr().join(" "); }
}

class FakeStyle {
    constructor() { this._props = {}; this.cssText = ""; }
    setProperty(k, v) { this._props[k] = String(v); this[k] = String(v); }
    getPropertyValue(k) { return this._props[k] || ""; }
    removeProperty(k) { delete this._props[k]; this[k] = ""; }
}

const documentElement = new FakeEl("html");
documentElement.style = new FakeStyle();

const fakeDocument = {
    documentElement,
    body: new FakeEl("body"),
    head: new FakeEl("head"),
    _keyListeners: {},
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (t) => new FakeText(t),
    addEventListener(type, fn) { (this._keyListeners[type] = this._keyListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
        const arr = this._keyListeners[type] || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
    },
    dispatch(type, ev) { (this._keyListeners[type] || []).slice().forEach((fn) => fn(ev)); },
    get activeElement() { return this.body; },
    querySelectorAll: (sel) => fakeDocument.body._allDescendants([]).filter((n) => n._matches(sel)),
    querySelector: (sel) => fakeDocument.querySelectorAll(sel)[0] || null,
    getElementById: (id) => fakeDocument.body._allDescendants([]).find((n) => n.id === id) || null,
};

const fakeLocalStorage = (() => {
    const store = {};
    return {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
    };
})();

globalThis.window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle(el) {
        return {
            getPropertyValue(k) { return el.style ? el.style.getPropertyValue(k) : ""; },
        };
    },
};
globalThis.document = fakeDocument;
globalThis.localStorage = fakeLocalStorage;
globalThis.getComputedStyle = globalThis.window.getComputedStyle;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

export {
    splitAttrs,
    parseHTML,
    FakeText,
    FakeEl,
    FakeClassList,
    FakeStyle,
    fakeDocument,
    fakeLocalStorage,
};

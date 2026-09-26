/**
 * Functions run inside page frames via Runtime.callFunctionOn, always in the
 * driver's ISOLATED world (never the page main world, whose prototypes the
 * page can patch). They are plain JavaScript source strings (not TS functions)
 * so no transpiler helper can leak into them and the DOM lib types are not
 * needed by the Node-side typecheck.
 *
 * The collector is ported from packages/happy-browser-extension/src/snapshot.js
 * (visibility / role / name logic, open shadow root traversal) and returns the
 * element nodes themselves so the driver can bind refs to backendNodeIds.
 */

export interface CollectorLimits {
    maxElements: number
    maxTextChars: number
}

export interface CollectedElement {
    tag: string
    role: string
    name: string
    value?: string
    disabled?: boolean
    visible: boolean
}

export interface CollectedFrame {
    url: string
    title: string
    text: string
    truncated: boolean
    elements: CollectedElement[]
}

/**
 * Role and accessible-name logic shared by the collector and the per-element
 * scripts, so a label read at dispatch time is computed exactly like the one the
 * agent saw in its snapshot. Spliced into each function body (a source snippet).
 */
const ELEMENT_NAMING = String.raw`    // Containers get refs so a later observe can be scoped to their subtree.
    const CONTAINER = [
        'form', 'dialog', 'fieldset', 'nav', 'main', 'section[aria-label]', 'section[aria-labelledby]',
        '[role="region"]', '[role="group"]', '[role="dialog"]', '[role="list"]', '[role="listbox"]',
        '[role="menu"]', '[role="form"]', '[role="navigation"]', '[role="main"]',
    ].join(',')
    const MAX_NAME = 120
    const clean = (text) => (text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)

    const roleOf = (element) => {
        const explicit = element.getAttribute('role')
        if (explicit) return explicit
        const tag = element.tagName.toLowerCase()
        if (tag === 'a') return 'link'
        if (tag === 'button' || tag === 'summary') return 'button'
        if (tag === 'select') return 'combobox'
        if (tag === 'textarea') return 'textbox'
        if (tag === 'form') return 'form'
        if (tag === 'dialog') return 'dialog'
        if (tag === 'fieldset') return 'group'
        if (tag === 'nav') return 'navigation'
        if (tag === 'main') return 'main'
        if (tag === 'section') return 'region'
        if ((element).isContentEditable) return 'textbox'
        if (tag === 'input') {
            const type = (element.getAttribute('type') || 'text').toLowerCase()
            if (type === 'checkbox' || type === 'radio') return type
            if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
            return 'textbox'
        }
        return 'generic'
    }
    const isContainer = (element) => element.matches(CONTAINER)
    const nameOf = (element) => {
        const label = element.getAttribute('aria-label')
        if (label) return clean(label)
        const labelledBy = element.getAttribute('aria-labelledby')
        if (labelledBy) {
            const target = (element.getRootNode()).getElementById?.(labelledBy)
                ?? element.ownerDocument.getElementById(labelledBy)
            if (target) return clean(target.textContent)
        }
        const labels = (element).labels
        if (labels && labels[0]) return clean(labels[0].textContent)
        const placeholder = element.getAttribute('placeholder')
        if (placeholder) return clean(placeholder)
        if (isContainer(element)) {
            const legend = element.tagName === 'FIELDSET' ? element.querySelector('legend') : null
            return clean(legend?.textContent || element.getAttribute('title') || '')
        }
        const text = clean(element.textContent)
        if (text) return text
        return clean(element.getAttribute('name') || element.getAttribute('title') || '')
    }

`

export const COLLECT_FRAME = String.raw`function collectFrame(limits, scope) {
    const INTERACTIVE = [
        'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
        '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
        '[role="menuitem"]', '[role="textbox"]', '[role="switch"]', '[role="option"]',
        '[contenteditable="true"]', '[contenteditable=""]',
    ].join(',')
${ELEMENT_NAMING}
    const parentAcrossShadow = (element) => {
        if (element.assignedSlot) return element.assignedSlot
        if (element.parentElement) return element.parentElement
        const root = element.getRootNode()
        return root && (root).host ? (root).host : null
    }
    const styles = new Map()
    const styleOf = (element) => {
        let style = styles.get(element)
        if (!style) {
            style = element.ownerDocument.defaultView.getComputedStyle(element)
            styles.set(element, style)
        }
        return style
    }
    const hiddenTrees = new Map()
    const isInHiddenTree = (element) => {
        const cached = hiddenTrees.get(element)
        if (cached !== undefined) return cached
        const parent = parentAcrossShadow(element)
        const style = styleOf(element)
        const firstSummary = parent?.tagName === 'DETAILS'
            ? Array.from(parent.children).find((child) => child.tagName === 'SUMMARY')
            : null
        const collapsedByDetails = parent?.tagName === 'DETAILS' && !parent.hasAttribute('open') && element !== firstSummary
        const hidden = element.hasAttribute('hidden')
            || element.hasAttribute('inert')
            || element.getAttribute('aria-hidden') === 'true'
            || style.display === 'none'
            || collapsedByDetails
            || (parent ? styleOf(parent).contentVisibility === 'hidden' : false)
            || (parent ? isInHiddenTree(parent) : false)
        hiddenTrees.set(element, hidden)
        return hidden
    }
    const isVisible = (element) => {
        if (isInHiddenTree(element)) return false
        const visibility = styleOf(element).visibility
        if (visibility === 'hidden' || visibility === 'collapse') return false
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
    }
    const elements = []
    const nodes = []
    let truncated = false
    const record = (element) => {
        if (elements.length >= limits.maxElements) {
            truncated = true
            return
        }
        const tag = element.tagName.toLowerCase()
        const entry = { tag, role: roleOf(element), name: nameOf(element), visible: isVisible(element) }
        const isPassword = tag === 'input' && ((element).type || '').toLowerCase() === 'password'
        const value = (element).value
        // Password values are never read out, not even redacted-length hints.
        if (!isPassword && !isContainer(element) && typeof value === 'string' && value !== '') entry.value = value.slice(0, 200)
        if ((element).disabled === true || element.getAttribute('aria-disabled') === 'true') entry.disabled = true
        elements.push(entry)
        nodes.push(element)
    }
    const walk = (root) => {
        for (const element of Array.from(root.querySelectorAll('*'))) {
            if (element.matches(INTERACTIVE) || element.matches(CONTAINER)) record(element)
            if (element.shadowRoot) walk(element.shadowRoot)
        }
    }
    if (scope) {
        if (scope.shadowRoot) walk(scope.shadowRoot)
        walk(scope)
    } else {
        walk(document)
    }

    const textRoot = (scope) ?? document.body ?? document.documentElement
    let text = textRoot ? ((textRoot).innerText || '') : ''
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    if (text.length > limits.maxTextChars) {
        text = text.slice(0, limits.maxTextChars)
        truncated = true
    }
    const meta = { url: location.href, title: document.title, text, truncated, elements }
    return { json: JSON.stringify(meta), nodes }
}`

export type ElementState = 'ok' | 'detached' | 'invisible' | 'disabled' | 'not-editable'

/** `this` = the target element. */
export const CHECK_ELEMENT = String.raw`function checkElement(forFill) {
    const element = this
    if (!element.isConnected) return 'detached'
    for (let node = element; node; ) {
        if (node.hasAttribute('hidden') || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return 'invisible'
        const root = node.getRootNode()
        node = node.assignedSlot ?? node.parentElement ?? (root && root.host ? root.host : null)
    }
    const visibleByCss = typeof (element).checkVisibility === 'function'
        ? (element).checkVisibility({ checkVisibilityCSS: true })
        : true
    const rect = element.getBoundingClientRect()
    if (!visibleByCss || rect.width <= 0 || rect.height <= 0) return 'invisible'
    if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return 'disabled'
    if (forFill) {
        const tag = element.tagName.toLowerCase()
        const type = ((element).type || '').toLowerCase()
        const textInput = tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'].includes(type)
        const editable = textInput || tag === 'textarea' || (element).isContentEditable
        if (!editable || (element).readOnly) return 'not-editable'
    }
    return 'ok'
}`

/** `this` = the target element. True when its centre point hits it (not an overlay). */
export const HIT_TEST = String.raw`function hitTest() {
    const element = this
    const rect = element.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const root = element.getRootNode()
    const hit = (typeof (root).elementFromPoint === 'function' ? root : document).elementFromPoint(x, y)
    return !!hit && (hit === element || element.contains(hit))
}`

/** `this` = the target element. Its role and accessible name now, computed like the snapshot's. */
export const LABEL_OF = String.raw`function labelOf() {
${ELEMENT_NAMING}
    return { role: roleOf(this), name: nameOf(this) }
}`

/**
 * Walks up from an element (incoming = null: start at its centre, the point
 * HIT_TEST checks) or from an iframe element in a parent document (incoming =
 * the point in that iframe's client coordinates) through every same-process
 * ancestor document, requiring each to hit the iframe element itself at the
 * point, i.e. nothing of a parent document covers it.
 * Returns { covered } | { top } | { unsupported } | { point, levels } when the
 * next parent is in another process (the caller continues there; levels =
 * frames climbed here). The mapping below is a plain offset: when the iframe or
 * any ancestor is transformed or zoomed it is wrong, so that is reported as
 * unsupported (the action is handed to the user) instead of being guessed.
 */
export const CLIMB_FRAMES = String.raw`function climbFrames(incoming) {
    const plainGeometry = (owner) => {
        for (let node = owner; node; ) {
            const style = node.ownerDocument.defaultView.getComputedStyle(node)
            if (style.transform !== 'none' || (style.rotate && style.rotate !== 'none') || (style.scale && style.scale !== 'none')
                || (style.translate && style.translate !== 'none') || (style.zoom && style.zoom !== '1' && style.zoom !== 'normal')) return false
            const root = node.getRootNode()
            node = node.assignedSlot ?? node.parentElement ?? (root && root.host ? root.host : null)
        }
        return true
    }
    const hitOwner = (owner, p) => {
        if (!plainGeometry(owner)) return { unsupported: true }
        const rect = owner.getBoundingClientRect()
        const style = owner.ownerDocument.defaultView.getComputedStyle(owner)
        const x = rect.left + owner.clientLeft + parseFloat(style.paddingLeft || '0') + p.x
        const y = rect.top + owner.clientTop + parseFloat(style.paddingTop || '0') + p.y
        const root = owner.getRootNode()
        const hit = (typeof root.elementFromPoint === 'function' ? root : owner.ownerDocument).elementFromPoint(x, y)
        return { hit: hit === owner, point: { x, y } }
    }
    let point
    if (incoming) {
        const first = hitOwner(this, incoming)
        if (first.unsupported) return { unsupported: true }
        if (!first.hit) return { covered: true }
        point = first.point
    } else {
        const rect = this.getBoundingClientRect()
        point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
    let doc = this.ownerDocument
    let levels = 0
    for (;;) {
        const win = doc.defaultView
        if (!win) return { covered: true }
        if (win === win.top) return { top: true }
        let owner = null
        try { owner = win.frameElement } catch { owner = null }
        if (!owner) return { point, levels }
        const next = hitOwner(owner, point)
        if (next.unsupported) return { unsupported: true }
        if (!next.hit) return { covered: true }
        point = next.point
        doc = owner.ownerDocument
        levels += 1
    }
}`

/** `this` = a node resolved into some frame's isolated world; true when it belongs to that frame's document. */
export const IN_THIS_DOCUMENT = String.raw`function inThisDocument() {
    return this.ownerDocument === document
}`

/** `this` = the target element; selects its current content so insertText replaces it. */
/** Focuses and selects the element; returns whether it (still) holds focus, so text never goes elsewhere. */
export const SELECT_CONTENT = String.raw`function selectContent() {
    const element = this
    element.focus()
    const root = element.getRootNode()
    const focused = () => (root.activeElement ?? element.ownerDocument.activeElement) === element
    if (typeof element.select === 'function') {
        element.select()
        return focused()
    }
    const selection = element.ownerDocument.getSelection()
    if (!selection) return focused()
    const range = element.ownerDocument.createRange()
    range.selectNodeContents(element)
    selection.removeAllRanges()
    selection.addRange(range)
    return focused()
}`

export const FRAME_HAS_TEXT = String.raw`function frameHasText(needle) {
    const body = document.body ?? document.documentElement
    return !!body && ((body).innerText || '').includes(needle)
}`

/**
 * `submissionOf(form, submitter)`: what submitting `form` with `submitter` (or
 * null) would send, as a FormSubmission. The entry list is built by hand (HTML
 * "constructing the entry list") instead of `new FormData(form)`, which would fire
 * the page's `formdata` handlers; form attributes are read through the prototype
 * getters because a control named "action" or "elements" shadows them.
 * `baseTargetOf(doc)`: the document's <base target>. Spliced into function bodies.
 */
const FORM_SUBMISSION = String.raw`    const baseTargetOf = (doc) => {
        const base = doc.querySelector('base[target]')
        return base ? String(base.getAttribute('target') || '') : ''
    }
    const submissionOf = (form, submitter) => {
        const formProp = (name) => Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, name).get.call(form)
        const controls = Array.from(formProp('elements'))
        const formAction = String(formProp('action') || form.ownerDocument.location.href)
        const override = (attribute, property, fallback) => submitter && submitter.hasAttribute(attribute) ? String(submitter[property]) : fallback
        const attr = (attribute) => submitter.hasAttribute(attribute) ? submitter.getAttribute(attribute) : null
        const fields = []
        let opaque = false
        for (const field of controls) {
            const fieldTag = field.tagName.toLowerCase()
            const fieldType = String(field.type || '').toLowerCase()
            if (fieldTag.includes('-')) { opaque = true; continue }
            if (fieldTag === 'object' || fieldTag === 'fieldset' || fieldTag === 'output') continue
            if (field.matches(':disabled')) continue
            const isButton = fieldTag === 'button' || (fieldTag === 'input' && ['submit', 'image', 'reset', 'button'].includes(fieldType))
            if (isButton && field !== submitter) continue
            const name = field.getAttribute('name') || ''
            if (fieldTag === 'input' && fieldType === 'image') {
                // The coordinates are where the driver presses: the element's centre.
                const prefix = name ? name + '.' : ''
                fields.push([prefix + 'x', 'centre'], [prefix + 'y', 'centre'])
                continue
            }
            if (!name) continue
            if (fieldTag === 'select') {
                for (const option of Array.from(field.options)) if (option.selected && !option.disabled) fields.push([name, String(option.value)])
                continue
            }
            if (fieldTag === 'input' && (fieldType === 'checkbox' || fieldType === 'radio')) {
                if (field.checked) fields.push([name, field.hasAttribute('value') ? String(field.value) : 'on'])
                continue
            }
            if (fieldTag === 'input' && fieldType === 'file') {
                const files = Array.from(field.files || [])
                if (files.length) opaque = true
                if (!files.length) fields.push([name, { file: '', size: 0, type: 'application/octet-stream' }])
                for (const file of files) fields.push([name, { file: String(file.name), size: file.size, type: String(file.type) }])
                continue
            }
            if (fieldTag === 'input' && fieldType === 'password') {
                // Never read out; a non-empty one cannot be bound, so the form is opaque.
                if (String(field.value) !== '') opaque = true
                fields.push([name, { password: String(field.value).length }])
                continue
            }
            if (fieldTag === 'input' && fieldType === 'hidden' && name.toLowerCase() === '_charset_' && !field.hasAttribute('value')) {
                fields.push([name, 'UTF-8'])
                continue
            }
            fields.push([name, String(field.value ?? '')])
            const dirname = field.getAttribute('dirname')
            if (dirname && (fieldTag === 'textarea' || fieldType === 'text' || fieldType === 'search')) fields.push([dirname, field.matches(':dir(rtl)') ? 'rtl' : 'ltr'])
        }
        return {
            action: override('formaction', 'formAction', formAction),
            method: override('formmethod', 'formMethod', String(formProp('method') || 'get')).toLowerCase(),
            enctype: override('formenctype', 'formEnctype', String(formProp('enctype') || 'application/x-www-form-urlencoded')).toLowerCase(),
            target: override('formtarget', 'formTarget', form.hasAttribute('target') ? String(formProp('target') || '') : baseTargetOf(form.ownerDocument)),
            fields,
            submitter: submitter ? { name: submitter.getAttribute('name') || '', value: String(submitter.value ?? ''),
                formaction: attr('formaction'), formmethod: attr('formmethod'), formenctype: attr('formenctype') } : null,
            opaque,
        }
    }
    const submitsForm = (element) => {
        const tag = element.tagName.toLowerCase()
        const type = (element.getAttribute('type') || '').toLowerCase()
        return (tag === 'button' && (type === '' || type === 'submit')) || (tag === 'input' && (type === 'submit' || type === 'image'))
    }
`

/** Runs on a resolved element; reads its current role/name, link and form context without touching page state. */
export const DESCRIBE_ELEMENT = String.raw`function describeElement() {
${ELEMENT_NAMING}
${FORM_SUBMISSION}
    const element = this
    const tag = element.tagName.toLowerCase()
    const result = { pageUrl: String(location.href), role: roleOf(element), name: nameOf(element), tag, formValues: {} }
    // A browsing-context name set on the link or form wins; else the document's <base target>.
    const link = element.closest && element.closest('a[href]')
    if (link) {
        result.linkUrl = String(link.href)
        result.linkTarget = link.hasAttribute('target') ? String(link.getAttribute('target') || '') : baseTargetOf(document)
    }
    const form = element.form || (element.closest && element.closest('form'))
    if (!form) return result
    const formProp = (name) => Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, name).get.call(form)
    for (const field of Array.from(formProp('elements'))) {
        if (!field.name || field.type === 'password' || field.type === 'file') continue
        if ((field.type === 'checkbox' || field.type === 'radio') && !field.checked) continue
        result.formValues[field.name] = String(field.value ?? '').slice(0, 200)
    }
    result.formAction = String(formProp('action') || location.href)
    result.submitsForm = submitsForm(element)
    result.form = submissionOf(form, result.submitsForm ? element : null)
    return result
}`

/**
 * `this` = the element about to be clicked. Arms a one-shot guard on its form:
 * a capturing `submit` listener (isolated world) recomputes the submission and
 * cancels it when it differs from `expected`; a `formdata` listener compares the
 * final entry list and destination (page handlers that run later) and marks the
 * guard so the driver fails the resulting request before it is sent. Verdicts go
 * to the driver through the isolated-world binding `__abpGuardReport`.
 */
export const SUBMIT_GUARD = String.raw`function armSubmitGuard(expected, ttlMs) {
${FORM_SUBMISSION}
    const canonical = (value) => {
        if (value === null || typeof value !== 'object') return JSON.stringify(value)
        if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
        return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    }
    const element = this
    const form = element.form || (element.closest && element.closest('form'))
    if (!form) return false
    const win = form.ownerDocument.defaultView
    const want = canonical(expected)
    const state = { status: 'armed' }
    // The driver binding exists only in this isolated world; the page cannot call it.
    const report = (status) => {
        state.status = status
        if (typeof globalThis.__abpGuardReport === 'function') globalThis.__abpGuardReport(status)
    }
    const onSubmit = (event) => {
        if (event.target !== form || state.status !== 'armed') return
        if (canonical(submissionOf(form, event.submitter || null)) !== want) {
            event.preventDefault()
            event.stopImmediatePropagation()
            report('blocked')
            return
        }
        report('submitted')
    }
    // Non-empty passwords and files make a form opaque (handed to the user), so here they are empty.
    const expectedEntry = (value) => value && typeof value === 'object' && 'password' in value ? '' : value
    const entry = (value) => typeof value === 'string' ? value : { file: String(value.name), size: value.size, type: String(value.type) }
    const onFormData = (event) => {
        if (event.target !== form || state.status === 'blocked') return
        const actual = Array.from(event.formData.entries()).map(([name, value]) => [name, entry(value)])
        const sameFields = actual.length === expected.fields.length && actual.every(([name, value], i) => name === expected.fields[i][0]
            && (expected.fields[i][1] === 'centre' || canonical(value) === canonical(expectedEntry(expected.fields[i][1]))))
        const head = submissionOf(form, expected.submitter ? element : null)
        const sameHead = head.action === expected.action && head.method === expected.method && head.enctype === expected.enctype && head.target === expected.target
        // The browser builds the request after this: the driver verifies that request itself.
        report(!sameFields || !sameHead ? 'blocked' : 'submitting')
    }
    win.addEventListener('submit', onSubmit, true)
    form.addEventListener('formdata', onFormData)
    setTimeout(() => {
        win.removeEventListener('submit', onSubmit, true)
        form.removeEventListener('formdata', onFormData)
        if (state.status === 'armed') report('expired')
    }, ttlMs)
    return true
}`

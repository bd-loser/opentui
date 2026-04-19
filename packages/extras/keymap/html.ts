import { Keymap } from "./keymap.js"
import type { KeymapEvent, KeymapHost } from "./types.js"

export * from "./index.js"

export interface HtmlKeymapEvent extends KeymapEvent {
  readonly originalEvent?: KeyboardEvent
}

interface HtmlKeyboardEventLike {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  preventDefault(): void
  stopPropagation(): void
}

interface MutationObserverLike {
  observe(target: EventTarget, options?: unknown): void
  disconnect(): void
}

interface MutationObserverCtorLike {
  new (callback: () => void): MutationObserverLike
}

const keymapsByRoot = new WeakMap<HTMLElement, Keymap<HTMLElement, HtmlKeymapEvent>>()

const HTML_KEY_NAME_ALIASES = new Map<string, string>([
  [" ", "space"],
  ["Spacebar", "space"],
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
  ["Escape", "escape"],
  ["Esc", "escape"],
  ["Enter", "return"],
  ["Backspace", "backspace"],
  ["Delete", "delete"],
  ["Tab", "tab"],
  ["Home", "home"],
  ["End", "end"],
  ["PageUp", "pageup"],
  ["PageDown", "pagedown"],
  ["Insert", "insert"],
  ["CapsLock", "capslock"],
  ["NumLock", "numlock"],
  ["ScrollLock", "scrolllock"],
  ["ContextMenu", "menu"],
  ["Meta", "super"],
  ["OS", "super"],
  ["Alt", "alt"],
  ["Control", "control"],
  ["Shift", "shift"],
])

class HtmlWrappedKeymapEvent implements HtmlKeymapEvent {
  public propagationStopped = false

  constructor(
    public readonly name: string,
    public readonly ctrl: boolean,
    public readonly shift: boolean,
    public readonly meta: boolean,
    private readonly superKey: boolean,
    public readonly originalEvent?: KeyboardEvent,
  ) {}

  public get super(): boolean {
    return this.superKey
  }

  public preventDefault(): void {
    this.originalEvent?.preventDefault()
  }

  public stopPropagation(): void {
    this.propagationStopped = true
    this.originalEvent?.stopPropagation()
  }
}

function getMutationObserverCtor(): MutationObserverCtorLike | undefined {
  return globalThis.MutationObserver as MutationObserverCtorLike | undefined
}

export function normalizeHtmlKeyName(key: string): string {
  const aliased = HTML_KEY_NAME_ALIASES.get(key)
  if (aliased) {
    return aliased
  }

  if (/^F\d{1,2}$/i.test(key)) {
    return key.toLowerCase()
  }

  if (key.length === 1) {
    return key.toLowerCase()
  }

  return key.trim().toLowerCase().replace(/\s+/g, "")
}

export function createHtmlKeymapEvent(event?: KeyboardEvent | HtmlKeyboardEventLike): HtmlKeymapEvent {
  if (!event) {
    return new HtmlWrappedKeymapEvent("command", false, false, false, false)
  }

  const KeyboardEventCtor = globalThis.KeyboardEvent

  return new HtmlWrappedKeymapEvent(
    normalizeHtmlKeyName(event.key),
    event.ctrlKey,
    event.shiftKey,
    event.altKey,
    event.metaKey,
    KeyboardEventCtor && event instanceof KeyboardEventCtor ? event : undefined,
  )
}

class HtmlKeymapHost implements KeymapHost<HTMLElement, HtmlKeymapEvent> {
  public readonly rootTarget: HTMLElement
  public readonly isDestroyed = false

  private observer?: MutationObserverLike
  private readonly targetDestroyListeners = new Map<HTMLElement, Set<() => void>>()

  constructor(root: HTMLElement) {
    this.rootTarget = root
  }

  public getFocusedTarget(): HTMLElement | null {
    const active = this.rootTarget.ownerDocument.activeElement
    if (!active || typeof active !== "object") {
      return null
    }

    if (active === this.rootTarget || this.rootTarget.contains(active as HTMLElement)) {
      return active as HTMLElement
    }

    return null
  }

  public getParentTarget(target: HTMLElement): HTMLElement | null {
    return target.parentElement
  }

  public isTargetDestroyed(target: HTMLElement): boolean {
    if (target === this.rootTarget) {
      return false
    }

    return !target.isConnected || !this.rootTarget.contains(target)
  }

  public onKeyPress(listener: (event: HtmlKeymapEvent) => void): () => void {
    const onKeyDown = (event: KeyboardEvent) => {
      listener(createHtmlKeymapEvent(event))
    }

    this.rootTarget.addEventListener("keydown", onKeyDown, { capture: true })
    return () => {
      this.rootTarget.removeEventListener("keydown", onKeyDown, { capture: true })
    }
  }

  public onKeyRelease(listener: (event: HtmlKeymapEvent) => void): () => void {
    const onKeyUp = (event: KeyboardEvent) => {
      listener(createHtmlKeymapEvent(event))
    }

    this.rootTarget.addEventListener("keyup", onKeyUp, { capture: true })
    return () => {
      this.rootTarget.removeEventListener("keyup", onKeyUp, { capture: true })
    }
  }

  public onFocusChange(listener: (target: HTMLElement | null) => void): () => void {
    const notifyFocus = () => {
      queueMicrotask(() => {
        listener(this.getFocusedTarget())
      })
    }

    this.rootTarget.addEventListener("focusin", notifyFocus, { capture: true })
    this.rootTarget.addEventListener("focusout", notifyFocus, { capture: true })
    return () => {
      this.rootTarget.removeEventListener("focusin", notifyFocus, { capture: true })
      this.rootTarget.removeEventListener("focusout", notifyFocus, { capture: true })
    }
  }

  public onDestroy(_listener: () => void): () => void {
    return () => {}
  }

  public onTargetDestroy(target: HTMLElement, listener: () => void): () => void {
    let listeners = this.targetDestroyListeners.get(target)
    if (!listeners) {
      listeners = new Set()
      this.targetDestroyListeners.set(target, listeners)
    }

    listeners.add(listener)
    this.ensureObserver()
    this.flushDisconnectedTargets()

    return () => {
      const current = this.targetDestroyListeners.get(target)
      if (!current) {
        return
      }

      current.delete(listener)
      if (current.size === 0) {
        this.targetDestroyListeners.delete(target)
      }

      if (this.targetDestroyListeners.size === 0) {
        this.disconnectObserver()
      }
    }
  }

  public createCommandEvent(): HtmlKeymapEvent {
    return createHtmlKeymapEvent()
  }

  private ensureObserver(): void {
    if (this.observer || this.targetDestroyListeners.size === 0) {
      return
    }

    const MutationObserverCtor = getMutationObserverCtor()
    if (!MutationObserverCtor) {
      return
    }

    this.observer = new MutationObserverCtor(() => {
      this.flushDisconnectedTargets()
    })
    this.observer.observe(this.rootTarget, {
      childList: true,
      subtree: true,
    })
  }

  private disconnectObserver(): void {
    if (!this.observer) {
      return
    }

    this.observer.disconnect()
    this.observer = undefined
  }

  private flushDisconnectedTargets(): void {
    for (const [target, listeners] of this.targetDestroyListeners) {
      if (!this.isTargetDestroyed(target)) {
        continue
      }

      this.targetDestroyListeners.delete(target)
      for (const current of [...listeners]) {
        current()
      }
    }

    if (this.targetDestroyListeners.size === 0) {
      this.disconnectObserver()
    }
  }
}

export function createHtmlKeymapHost(root: HTMLElement): KeymapHost<HTMLElement, HtmlKeymapEvent> {
  return new HtmlKeymapHost(root)
}

export function getKeymap(root: HTMLElement): Keymap<HTMLElement, HtmlKeymapEvent> {
  const existing = keymapsByRoot.get(root)
  if (existing) {
    return existing
  }

  const keymap = new Keymap(createHtmlKeymapHost(root))
  keymapsByRoot.set(root, keymap)
  return keymap
}

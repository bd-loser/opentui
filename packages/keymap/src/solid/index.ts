import type { KeyEvent, Renderable } from "@opentui/core"
import { type Keymap, type LayerFields, type ReactiveMatcher } from "../index.js"
import {
  createComponent,
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  on,
  onCleanup,
  onMount,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js"

type OpenTuiKeymap = Keymap<Renderable, KeyEvent>

const KeymapContext = createContext<OpenTuiKeymap>()

export interface KeymapProviderProps {
  keymap: OpenTuiKeymap
  children: JSX.Element
}

export function KeymapProvider(props: KeymapProviderProps): JSX.Element {
  return createComponent(KeymapContext.Provider, {
    get value() {
      return props.keymap
    },
    get children() {
      return props.children
    },
  })
}

export type UseBindingsTarget<TRenderable extends Renderable = Renderable> = () => TRenderable | null | undefined

type UseBindingsLayerBase = LayerFields<Renderable, KeyEvent>

export interface UseGlobalBindingsLayer extends UseBindingsLayerBase {
  scope?: "global"
  target?: undefined
}

export interface UseFocusBindingsLayer<TRenderable extends Renderable = Renderable> extends UseBindingsLayerBase {
  scope: "focus"
  target: UseBindingsTarget<TRenderable>
}

export interface UseFocusWithinBindingsLayer<TRenderable extends Renderable = Renderable> extends UseBindingsLayerBase {
  scope: "focus-within"
  target: UseBindingsTarget<TRenderable>
}

export interface UseInferredFocusWithinBindingsLayer<
  TRenderable extends Renderable = Renderable,
> extends UseBindingsLayerBase {
  scope?: undefined
  target: UseBindingsTarget<TRenderable>
}

export type UseTargetBindingsLayer<TRenderable extends Renderable = Renderable> =
  | UseFocusBindingsLayer<TRenderable>
  | UseFocusWithinBindingsLayer<TRenderable>
  | UseInferredFocusWithinBindingsLayer<TRenderable>

export type UseBindingsLayer<TRenderable extends Renderable = Renderable> =
  | UseGlobalBindingsLayer
  | UseTargetBindingsLayer<TRenderable>

function resolveBindingsTarget(target: UseBindingsTarget | undefined): Renderable | undefined {
  return target?.() ?? undefined
}

export const useKeymap = (): OpenTuiKeymap => {
  const keymap = useContext(KeymapContext)

  if (!keymap) {
    throw new Error("Keymap not found. Wrap the tree in <KeymapProvider>.")
  }

  return keymap
}

function useKeymapStateVersion(keymap: OpenTuiKeymap): Accessor<number> {
  const [version, setVersion] = createSignal(0)
  let dispose: (() => void) | undefined

  onMount(() => {
    dispose = keymap.on("state", () => {
      setVersion((value) => value + 1)
    })

    setVersion((value) => value + 1)
  })

  onCleanup(() => {
    dispose?.()
  })

  return version
}

/**
 * Reactively derives any view from the current keymap by re-running `selector`
 * on each batched keymap state change.
 */
export const useKeymapSelector = <T>(selector: (keymap: OpenTuiKeymap) => T): Accessor<T> => {
  const keymap = useKeymap()
  const version = useKeymapStateVersion(keymap)

  return createMemo((previous) => {
    version()
    try {
      return selector(keymap)
    } catch (error) {
      if (
        previous !== undefined &&
        error instanceof Error &&
        error.message === "Cannot use a keymap after its host was destroyed"
      ) {
        return previous
      }

      throw error
    }
  })
}

export function useBindings<TRenderable extends Renderable = Renderable>(
  createLayer: () => UseGlobalBindingsLayer,
): void
export function useBindings<TRenderable extends Renderable = Renderable>(
  createLayer: () => UseTargetBindingsLayer<TRenderable>,
): void
export function useBindings<TRenderable extends Renderable = Renderable>(
  createLayer: () => UseBindingsLayer<TRenderable>,
): void {
  const keymap = useKeymap()

  createEffect(() => {
    const layer = createLayer()
    const hasExplicitTarget = layer.target !== undefined
    const explicitTarget = resolveBindingsTarget(layer.target)
    const resolvedScope = layer.scope ?? (hasExplicitTarget ? "focus-within" : "global")

    const { scope: _scope, target: _target, ...baseLayer } = layer
    if (resolvedScope === "global") {
      const dispose = keymap.registerLayer({
        ...baseLayer,
        scope: "global",
      })

      onCleanup(() => {
        dispose()
      })

      return
    }

    if (!hasExplicitTarget) {
      throw new Error("useBindings local bindings need a target accessor")
    }

    if (!explicitTarget) {
      return
    }

    const dispose = keymap.registerLayer({
      ...baseLayer,
      scope: resolvedScope,
      target: explicitTarget,
    })

    onCleanup(() => {
      dispose()
    })
  })
}

/**
 * Adapts a Solid accessor to `ReactiveMatcher`. The subscription
 * lives in a disposable reactive root so unregistering the layer tears it
 * down. Pass `predicate` when the accessor value is not already boolean.
 */
export function reactiveMatcherFromSignal<T>(
  accessor: Accessor<T>,
  predicate?: (value: T) => boolean,
): ReactiveMatcher {
  return {
    get() {
      return predicate ? predicate(accessor()) : Boolean(accessor())
    },
    subscribe(onChange) {
      return createRoot((dispose) => {
        createEffect(on(accessor, () => onChange(), { defer: true }))
        return dispose
      })
    },
  }
}

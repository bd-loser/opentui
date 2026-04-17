export type EmitterListener<TValue> = [TValue] extends [void] ? () => void : (value: TValue) => void

type EmitterArgs<TValue> = [TValue] extends [void] ? [] : [TValue]

export type PriorityRegistration<TListener, TOptions extends { priority: number }> = Readonly<
  TOptions & {
    listener: TListener
    order: number
  }
>

export class OrderedRegistry<TValue> {
  private items: readonly TValue[] = []

  public append(value: TValue): () => void {
    this.items = [...this.items, value]

    return () => {
      this.remove(value)
    }
  }

  public prepend(value: TValue): () => void {
    this.items = [value, ...this.items]

    return () => {
      this.remove(value)
    }
  }

  public remove(value: TValue): boolean {
    const current = this.items
    if (current.length === 0) {
      return false
    }

    const next = current.filter((candidate) => candidate !== value)
    if (next.length === current.length) {
      return false
    }

    this.items = next
    return true
  }

  public has(): boolean {
    return this.items.length > 0
  }

  public values(): readonly TValue[] {
    return this.items
  }

  public clear(): void {
    this.items = []
  }
}

type EmitterListeners<TEvents extends Record<string, unknown>> = Partial<{
  [TName in keyof TEvents]: readonly EmitterListener<TEvents[TName]>[]
}>

export class Emitter<TEvents extends Record<string, unknown>> {
  private listeners: EmitterListeners<TEvents> = Object.create(null) as EmitterListeners<TEvents>

  constructor(private readonly onError: (name: keyof TEvents, error: unknown) => void) {}

  public hook<TName extends keyof TEvents>(name: TName, listener: EmitterListener<TEvents[TName]>): () => void {
    const current = this.listeners[name] ?? []
    this.listeners[name] = [...current, listener] as readonly EmitterListener<TEvents[TName]>[]

    return () => {
      const current = this.listeners[name]
      if (!current || current.length === 0) {
        return
      }

      const next = current.filter((candidate) => candidate !== listener) as readonly EmitterListener<TEvents[TName]>[]
      if (next.length === 0) {
        delete this.listeners[name]
        return
      }

      this.listeners[name] = next
    }
  }

  public has<TName extends keyof TEvents>(name: TName): boolean {
    return (this.listeners[name]?.length ?? 0) > 0
  }

  public off<TName extends keyof TEvents>(name: TName, listener: EmitterListener<TEvents[TName]>): void {
    const current = this.listeners[name]
    if (!current || current.length === 0) {
      return
    }

    const next = current.filter((candidate) => candidate !== listener) as readonly EmitterListener<TEvents[TName]>[]
    if (next.length === current.length) {
      return
    }

    if (next.length === 0) {
      delete this.listeners[name]
      return
    }

    this.listeners[name] = next
  }

  public clear(): void {
    this.listeners = Object.create(null) as EmitterListeners<TEvents>
  }

  public emit<TName extends keyof TEvents>(name: TName, ...args: EmitterArgs<TEvents[TName]>): void {
    const listeners = this.listeners[name] as readonly EmitterListener<TEvents[TName]>[] | undefined
    if (!listeners || listeners.length === 0) {
      return
    }

    for (const listener of listeners) {
      try {
        if (args.length === 0) {
          ;(listener as () => void)()
        } else {
          ;(listener as (value: TEvents[TName]) => void)(args[0] as TEvents[TName])
        }
      } catch (error) {
        this.onError(name, error)
      }
    }
  }
}

export class PriorityRegistry<TListener, TOptions extends { priority: number }> {
  private listeners: readonly PriorityRegistration<TListener, TOptions>[] = []
  private order = 0

  public register(listener: TListener, options: TOptions): () => void {
    const registered = { ...options, listener, order: this.order++ } as PriorityRegistration<TListener, TOptions>

    this.listeners = [...this.listeners, registered].sort((left, right) => {
      const priorityDiff = right.priority - left.priority
      if (priorityDiff !== 0) {
        return priorityDiff
      }

      return left.order - right.order
    })

    return () => {
      const current = this.listeners
      if (current.length === 0) {
        return
      }

      const next = current.filter((candidate) => candidate !== registered)
      if (next.length === current.length) {
        return
      }

      this.listeners = next
    }
  }

  public has(): boolean {
    return this.listeners.length > 0
  }

  public entries(): readonly PriorityRegistration<TListener, TOptions>[] {
    return this.listeners
  }

  public clear(): void {
    this.listeners = []
  }
}

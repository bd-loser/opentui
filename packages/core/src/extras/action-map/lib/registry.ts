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

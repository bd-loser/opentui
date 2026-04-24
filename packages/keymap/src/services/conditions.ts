import type { NotificationService } from "./notify.js"
import type { State } from "./state.js"
import type { KeymapEvent, ReactiveMatcher, RegisteredLayer, RuntimeMatchable, RuntimeMatcher } from "../types.js"

function isReactiveMatcher(value: unknown): value is ReactiveMatcher {
  if (!value || typeof value !== "object") {
    return false
  }

  const candidate = value as { get?: unknown; subscribe?: unknown }
  return typeof candidate.get === "function" && typeof candidate.subscribe === "function"
}

export class ConditionService<TTarget extends object, TEvent extends KeymapEvent> {
  constructor(
    private readonly state: State<TTarget, TEvent>,
    private readonly notify: NotificationService<TTarget, TEvent>,
  ) {}

  public buildRuntimeMatcher(matcher: (() => boolean) | ReactiveMatcher, source: string): RuntimeMatcher {
    if (typeof matcher === "function") {
      return {
        source,
        match: matcher,
        cacheable: false,
      }
    }

    if (isReactiveMatcher(matcher)) {
      return {
        source,
        match: () => matcher.get(),
        cacheable: true,
        subscribe: (onChange) => matcher.subscribe(onChange),
      }
    }

    throw new Error(`Keymap ${source} expected a function or a reactive matcher`)
  }

  public hasNoConditions(target: RuntimeMatchable): boolean {
    return target.requires.length === 0 && target.matchers.length === 0
  }

  public indexRuntimeMatchable(target: RuntimeMatchable): void {
    if (target.conditionKeys.length > 0) {
      for (const key of target.conditionKeys) {
        const dependents = this.state.conditions.runtimeKeyDependents.get(key)
        if (dependents) {
          dependents.add(target)
          continue
        }

        this.state.conditions.runtimeKeyDependents.set(key, new Set([target]))
      }
    }

    if (!target.hasUnkeyedMatchers) {
      target.matchCacheDirty = true
    }
  }

  public unindexRuntimeMatchable(target: RuntimeMatchable): void {
    if (target.conditionKeys.length === 0) {
      return
    }

    for (const key of target.conditionKeys) {
      const dependents = this.state.conditions.runtimeKeyDependents.get(key)
      if (!dependents) {
        continue
      }

      dependents.delete(target)
      if (dependents.size === 0) {
        this.state.conditions.runtimeKeyDependents.delete(key)
      }
    }
  }

  public invalidateRuntimeConditionKey(name: string): void {
    const dependents = this.state.conditions.runtimeKeyDependents.get(name)
    if (!dependents) {
      return
    }

    for (const target of dependents) {
      target.matchCacheDirty = true
    }
  }

  public matchesConditions(target: RuntimeMatchable): boolean {
    if (this.hasNoConditions(target)) {
      return true
    }

    if (this.hasFreshConditionCache(target)) {
      return target.matchCache === true
    }

    const matched = this.matchRequirements(target.requires) && this.matchesRuntimeMatchers(target)
    this.updateConditionCache(target, matched)
    return matched
  }

  public layerMatchesRuntimeState(layer: RegisteredLayer<TTarget, TEvent>): boolean {
    if (this.state.layers.layersWithConditions === 0 || this.hasNoConditions(layer)) {
      return true
    }

    return this.matchesConditions(layer)
  }

  private matchRequirements(requires: readonly [name: string, value: unknown][]): boolean {
    if (requires.length === 0) {
      return true
    }

    for (const [name, value] of requires) {
      if (!Object.is(this.state.runtime.data[name], value)) {
        return false
      }
    }

    return true
  }

  private hasFreshConditionCache(target: RuntimeMatchable): boolean {
    if (target.hasUnkeyedMatchers) {
      return false
    }

    return target.matchCacheDirty !== true && target.matchCache !== undefined
  }

  private updateConditionCache(target: RuntimeMatchable, matched: boolean): void {
    if (target.hasUnkeyedMatchers) {
      return
    }

    target.matchCacheDirty = false
    target.matchCache = matched
  }

  private matchesRuntimeMatcher(matcher: RuntimeMatcher): boolean {
    try {
      return matcher.match()
    } catch (error) {
      this.notify.emitError(
        "runtime-matcher-error",
        error,
        `[Keymap] Error evaluating runtime matcher from ${matcher.source}:`,
      )
      return false
    }
  }

  private matchesRuntimeMatchers(target: RuntimeMatchable): boolean {
    if (target.matchers.length === 0) {
      return true
    }

    if (target.matchers.length === 1) {
      const [matcher] = target.matchers
      return matcher ? this.matchesRuntimeMatcher(matcher) : true
    }

    for (const matcher of target.matchers) {
      if (!this.matchesRuntimeMatcher(matcher)) {
        return false
      }
    }

    return true
  }
}

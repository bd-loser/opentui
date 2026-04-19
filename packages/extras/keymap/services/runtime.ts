import type { EventData, KeymapEvent } from "../types.js"
import type { ConditionService } from "./conditions.js"
import type { NotificationService } from "./notify.js"
import type { ProjectionService } from "./projection.js"
import type { State } from "./state.js"

export class RuntimeService<TTarget extends object, TEvent extends KeymapEvent> {
  constructor(
    private readonly state: State<TTarget, TEvent>,
    private readonly notify: NotificationService<TTarget, TEvent>,
    private readonly conditions: ConditionService<TTarget, TEvent>,
    private readonly projection: ProjectionService<TTarget, TEvent>,
  ) {}

  public getData(name: string): unknown {
    return this.state.runtime.data[name]
  }

  public setData(name: string, value: unknown): void {
    this.notify.runWithStateChangeBatch(() => {
      if (value === undefined) {
        if (!(name in this.state.runtime.data)) {
          return
        }

        delete this.state.runtime.data[name]
        this.state.runtime.dataVersion += 1
        this.conditions.invalidateRuntimeConditionKey(name)
        this.projection.ensureValidPendingSequence()
        this.notify.queueStateChange()
        return
      }

      if (Object.is(this.state.runtime.data[name], value)) {
        return
      }

      this.state.runtime.data[name] = value
      this.state.runtime.dataVersion += 1
      this.conditions.invalidateRuntimeConditionKey(name)
      this.projection.ensureValidPendingSequence()
      this.notify.queueStateChange()
    })
  }

  public getReadonlyData(): Readonly<EventData> {
    if (this.state.runtime.readonlyDataVersion === this.state.runtime.dataVersion) {
      return this.state.runtime.readonlyData
    }

    this.state.runtime.readonlyData = Object.freeze({ ...this.state.runtime.data })
    this.state.runtime.readonlyDataVersion = this.state.runtime.dataVersion
    return this.state.runtime.readonlyData
  }
}

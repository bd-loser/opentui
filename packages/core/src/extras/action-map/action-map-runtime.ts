import type { Renderable } from "../../Renderable.js"
import type { CliRenderer } from "../../renderer.js"
import type { ActionMapState } from "./action-map-state.js"

export class ActionMapRuntime {
  constructor(
    private readonly state: ActionMapState,
    private readonly renderer: CliRenderer,
  ) {}

  public getFocusedRenderable(): Renderable | null {
    const focused = this.renderer.currentFocusedRenderable
    if (!focused) {
      return null
    }

    if (focused.isDestroyed) {
      return null
    }

    if (!focused.focused) {
      return null
    }

    return focused
  }

  public getData(name: string): unknown {
    return this.state.runtime.data[name]
  }
}

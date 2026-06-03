import { type LineInfo, type RenderContext } from "../types.js"
import { StyledText } from "../lib/styled-text.js"
import { SyntaxStyle } from "../syntax-style.js"
import { getTreeSitterClient, TreeSitterClient } from "../lib/tree-sitter/index.js"
import { TextBufferRenderable, type TextBufferOptions } from "./TextBufferRenderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import type { SimpleHighlight } from "../lib/tree-sitter/types.js"
import type { TextChunk } from "../text-buffer.js"
import { treeSitterToTextChunks } from "../lib/tree-sitter-styled-text.js"

export interface HighlightContext {
  content: string
  filetype: string
  syntaxStyle: SyntaxStyle
}

export type OnHighlightCallback = (
  highlights: SimpleHighlight[],
  context: HighlightContext,
) => SimpleHighlight[] | undefined | Promise<SimpleHighlight[] | undefined>

export interface ChunkRenderContext extends HighlightContext {
  highlights: SimpleHighlight[]
}

export type OnChunksCallback = (
  chunks: TextChunk[],
  context: ChunkRenderContext,
) => TextChunk[] | undefined | Promise<TextChunk[] | undefined>

export interface CodeOptions extends TextBufferOptions {
  content?: string
  filetype?: string
  syntaxStyle: SyntaxStyle
  treeSitterClient?: TreeSitterClient
  conceal?: boolean
  drawUnstyledText?: boolean
  streaming?: boolean
  baseHighlight?: string
  onHighlight?: OnHighlightCallback
  onChunks?: OnChunksCallback
}

export class CodeRenderable extends TextBufferRenderable {
  private _content: string
  private _filetype?: string
  private _syntaxStyle: SyntaxStyle
  private _isHighlighting: boolean = false
  private _treeSitterClient: TreeSitterClient
  private _highlightsDirty: boolean = false
  private _highlightSnapshotId: number = 0
  private _conceal: boolean
  private _drawUnstyledText: boolean
  private _shouldRenderTextBuffer: boolean = true
  private _streaming: boolean
  private _hadInitialContent: boolean = false
  private _lastHighlights: SimpleHighlight[] = []
  private _baseHighlight?: string
  private _onHighlight?: OnHighlightCallback
  private _onChunks?: OnChunksCallback
  private _highlightingPromise: Promise<void> = Promise.resolve()
  private _renderedLineSources?: number[]

  protected _contentDefaultOptions = {
    content: "",
    conceal: true,
    drawUnstyledText: true,
    streaming: false,
  } satisfies Partial<CodeOptions>

  constructor(ctx: RenderContext, options: CodeOptions) {
    super(ctx, options)

    this._content = options.content ?? this._contentDefaultOptions.content
    this._filetype = options.filetype
    this._syntaxStyle = options.syntaxStyle
    this._treeSitterClient = options.treeSitterClient ?? getTreeSitterClient()
    this._conceal = options.conceal ?? this._contentDefaultOptions.conceal
    this._drawUnstyledText = options.drawUnstyledText ?? this._contentDefaultOptions.drawUnstyledText
    this._streaming = options.streaming ?? this._contentDefaultOptions.streaming
    this._baseHighlight = options.baseHighlight
    this._onHighlight = options.onHighlight
    this._onChunks = options.onChunks

    if (this._content.length > 0) {
      this.textBuffer.setText(this._content)
      this.updateTextInfo()
      this._shouldRenderTextBuffer = this._drawUnstyledText || !this._filetype
    }

    this._highlightsDirty = this._content.length > 0
  }

  get content(): string {
    return this._content
  }

  set content(value: string) {
    if (this._content !== value) {
      this._content = value
      this._highlightsDirty = true
      this._highlightSnapshotId++

      if (this._streaming && !this._drawUnstyledText && this._filetype) {
        this.requestRender()
        return
      }

      this.textBuffer.setText(value)
      this._renderedLineSources = undefined
      this.updateTextInfo()
    }
  }

  public override get lineInfo(): LineInfo {
    const lineInfo = super.lineInfo
    if (!this._renderedLineSources) return lineInfo

    return {
      ...lineInfo,
      lineSources: lineInfo.lineSources.map((line) => this._renderedLineSources?.[line] ?? line),
    }
  }

  get filetype(): string | undefined {
    return this._filetype
  }

  set filetype(value: string | undefined) {
    if (this._filetype !== value) {
      this._filetype = value
      this._highlightsDirty = true
    }
  }

  get syntaxStyle(): SyntaxStyle {
    return this._syntaxStyle
  }

  set syntaxStyle(value: SyntaxStyle) {
    if (this._syntaxStyle !== value) {
      this._syntaxStyle = value
      this._highlightsDirty = true
    }
  }

  get conceal(): boolean {
    return this._conceal
  }

  set conceal(value: boolean) {
    if (this._conceal !== value) {
      this._conceal = value
      this._highlightsDirty = true
    }
  }

  get drawUnstyledText(): boolean {
    return this._drawUnstyledText
  }

  set drawUnstyledText(value: boolean) {
    if (this._drawUnstyledText !== value) {
      this._drawUnstyledText = value
      this._highlightsDirty = true
    }
  }

  get streaming(): boolean {
    return this._streaming
  }

  set streaming(value: boolean) {
    if (this._streaming !== value) {
      this._streaming = value
      this._hadInitialContent = false
      this._lastHighlights = []
      this._highlightsDirty = true
    }
  }

  get treeSitterClient(): TreeSitterClient {
    return this._treeSitterClient
  }

  set treeSitterClient(value: TreeSitterClient) {
    if (this._treeSitterClient !== value) {
      this._treeSitterClient = value
      this._highlightsDirty = true
    }
  }

  get onHighlight(): OnHighlightCallback | undefined {
    return this._onHighlight
  }

  get baseHighlight(): string | undefined {
    return this._baseHighlight
  }

  set baseHighlight(value: string | undefined) {
    if (this._baseHighlight !== value) {
      this._baseHighlight = value
      this._highlightsDirty = true
    }
  }

  set onHighlight(value: OnHighlightCallback | undefined) {
    if (this._onHighlight !== value) {
      this._onHighlight = value
      this._highlightsDirty = true
    }
  }

  get onChunks(): OnChunksCallback | undefined {
    return this._onChunks
  }

  set onChunks(value: OnChunksCallback | undefined) {
    if (this._onChunks !== value) {
      this._onChunks = value
      this._highlightsDirty = true
    }
  }

  get isHighlighting(): boolean {
    return this._isHighlighting
  }

  get highlightingDone(): Promise<void> {
    return this._highlightingPromise
  }

  protected async transformChunks(chunks: TextChunk[], context: ChunkRenderContext): Promise<TextChunk[]> {
    if (!this._onChunks) return chunks

    const modified = await this._onChunks(chunks, context)
    return modified ?? chunks
  }

  private ensureVisibleTextBeforeHighlight(): void {
    if (this.isDestroyed) return

    const content = this._content

    if (!this._filetype) {
      this._shouldRenderTextBuffer = true
      return
    }

    const isInitialContent = this._streaming && !this._hadInitialContent
    const shouldDrawUnstyledNow = this._streaming ? isInitialContent && this._drawUnstyledText : this._drawUnstyledText

    if (this._streaming && !isInitialContent) {
      this._shouldRenderTextBuffer = true
    } else if (shouldDrawUnstyledNow) {
      this.textBuffer.setText(content)
      this._renderedLineSources = undefined
      this._shouldRenderTextBuffer = true
    } else {
      this._shouldRenderTextBuffer = false
    }
  }

  private async startHighlight(): Promise<void> {
    const content = this._content
    const filetype = this._filetype
    const snapshotId = ++this._highlightSnapshotId

    if (!filetype) return

    const isInitialContent = this._streaming && !this._hadInitialContent
    if (isInitialContent) {
      this._hadInitialContent = true
    }

    this._isHighlighting = true

    try {
      const result = await this._treeSitterClient.highlightOnce(content, filetype)

      if (snapshotId !== this._highlightSnapshotId) {
        this.requestRender()
        return
      }

      if (this.isDestroyed) return

      let highlights = result.highlights ?? []

      if (this._onHighlight && highlights.length >= 0) {
        const context: HighlightContext = {
          content,
          filetype,
          syntaxStyle: this._syntaxStyle,
        }
        const modified = await this._onHighlight(highlights, context)
        if (modified !== undefined) {
          highlights = modified
        }
      }

      if (snapshotId !== this._highlightSnapshotId) {
        this.requestRender()
        return
      }

      if (this.isDestroyed) return

      if (highlights.length > 0) {
        if (this._streaming) {
          this._lastHighlights = highlights
        }
      }

      if (highlights.length > 0 || this._onChunks || this._baseHighlight) {
        const context: ChunkRenderContext = {
          content,
          filetype,
          syntaxStyle: this._syntaxStyle,
          highlights,
        }

        let chunks = treeSitterToTextChunks(content, highlights, this._syntaxStyle, {
          enabled: this._conceal,
          baseHighlight: this._baseHighlight,
        })
        const renderedLineSources = this._onChunks ? undefined : this.getConcealedLineSources(content, highlights)

        chunks = await this.transformChunks(chunks, context)

        if (snapshotId !== this._highlightSnapshotId) {
          this.requestRender()
          return
        }

        if (this.isDestroyed) return

        const styledText = new StyledText(chunks)
        this.textBuffer.setStyledText(styledText)
        this._renderedLineSources = renderedLineSources
      } else {
        this.textBuffer.setText(content)
        this._renderedLineSources = undefined
      }

      this._shouldRenderTextBuffer = true
      this._isHighlighting = false
      this._highlightsDirty = false
      this.updateTextInfo()
      this.requestRender()
    } catch (error) {
      if (snapshotId !== this._highlightSnapshotId) {
        this.requestRender()
        return
      }

      console.warn("Code highlighting failed, falling back to plain text:", error)
      if (this.isDestroyed) return
      this.textBuffer.setText(content)
      this._renderedLineSources = undefined
      this._shouldRenderTextBuffer = true
      this._isHighlighting = false
      this._highlightsDirty = false
      this.updateTextInfo()
      this.requestRender()
    }
  }

  private static isIdentityLineSources(lineSources: number[]): boolean {
    for (let i = 0; i < lineSources.length; i++) {
      if (lineSources[i] !== i) return false
    }
    return true
  }

  private getConcealedLineSources(content: string, highlights: SimpleHighlight[]): number[] | undefined {
    if (!this._conceal || content.length === 0) return undefined

    const lineConcealHighlights = highlights
      .filter((highlight) => highlight[3]?.concealLines !== undefined)
      .sort((a, b) => a[0] - b[0])

    if (lineConcealHighlights.length === 0) return undefined

    const lineSources: number[] = []
    let line = 0
    let lineStart = 0
    let nextHighlightIndex = 0
    let currentRenderedLineHasText = false

    const setCurrentRenderedLineSource = (sourceLine: number, hasText: boolean): void => {
      if (lineSources.length === 0) {
        lineSources.push(sourceLine)
      } else if (!currentRenderedLineHasText) {
        lineSources[lineSources.length - 1] = sourceLine
      }

      if (hasText) {
        currentRenderedLineHasText = true
      }
    }

    while (lineStart <= content.length) {
      const newlineOffset = content.indexOf("\n", lineStart)
      const lineEnd = newlineOffset === -1 ? content.length : newlineOffset

      while (
        nextHighlightIndex < lineConcealHighlights.length &&
        lineConcealHighlights[nextHighlightIndex][1] <= lineStart
      ) {
        nextHighlightIndex++
      }

      let coveredUntil = lineStart
      let concealedLineBreak = false
      for (let i = nextHighlightIndex; i < lineConcealHighlights.length; i++) {
        const highlight = lineConcealHighlights[i]
        if (highlight[0] > lineEnd) break
        if (highlight[0] < lineStart || highlight[1] > lineEnd) continue
        if (highlight[3]?.conceal === "" && highlight[0] <= coveredUntil) {
          coveredUntil = Math.max(coveredUntil, highlight[1])
        }
        if (highlight[1] < content.length && content[highlight[1]] === "\n") {
          concealedLineBreak = true
        }
      }

      const fullyConcealed = lineEnd > lineStart && coveredUntil >= lineEnd
      const concealedWholeLineWithBreak = concealedLineBreak && fullyConcealed

      if (!concealedWholeLineWithBreak) {
        const hasText = lineEnd > lineStart && !fullyConcealed
        if (hasText || newlineOffset !== -1 || !fullyConcealed) {
          setCurrentRenderedLineSource(line, hasText)
        }

        if (newlineOffset !== -1 && !concealedLineBreak) {
          lineSources.push(line + 1)
          currentRenderedLineHasText = false
        }
      }

      line++
      if (newlineOffset === -1) break
      lineStart = newlineOffset + 1
    }

    if (lineSources.length === 0 || CodeRenderable.isIdentityLineSources(lineSources)) return undefined
    return lineSources
  }

  public getLineHighlights(lineIdx: number) {
    return this.textBuffer.getLineHighlights(lineIdx)
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (this._highlightsDirty) {
      if (this.isDestroyed) return

      if (this._content.length === 0) {
        this._shouldRenderTextBuffer = false
        this._highlightsDirty = false
      } else if (!this._filetype) {
        this._shouldRenderTextBuffer = true
        this._highlightsDirty = false
      } else {
        this.ensureVisibleTextBeforeHighlight()
        this._highlightsDirty = false
        this._highlightingPromise = this.startHighlight()
      }
    }

    if (!this._shouldRenderTextBuffer) return
    super.renderSelf(buffer)
  }
}

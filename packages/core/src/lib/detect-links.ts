import type { TextChunk } from "../text-buffer.js"
import type { SimpleHighlight } from "./tree-sitter/types.js"

const URL_SCOPES = ["markup.link.url", "string.special.url"]
const RAW_SCOPES = ["markup.raw", "markup.raw.block"]
const MAX_LINK_TARGET_BYTES = 512

type SourceRange = readonly [start: number, end: number]

interface LinkRange {
  start: number
  end: number
  url: string
}

export function detectLinks(
  chunks: TextChunk[],
  context: { content: string; highlights: SimpleHighlight[]; sourceRanges?: ReadonlyArray<SourceRange> },
): TextChunk[] {
  const ranges = collectLinkRanges(context.content, context.highlights)
  if (ranges.length === 0) return chunks

  const sourceRanges = context.sourceRanges ?? getSequentialSourceRanges(chunks)
  const result: TextChunk[] = []
  let linkIndex = 0

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex]
    const sourceRange = sourceRanges[chunkIndex]
    if (!sourceRange) {
      result.push(chunk)
      continue
    }

    while (linkIndex < ranges.length && ranges[linkIndex].end <= sourceRange[0]) linkIndex++
    const range = ranges[linkIndex]
    if (!range || range.start >= sourceRange[1]) {
      result.push(chunk)
      continue
    }

    const sourceText = context.content.slice(sourceRange[0], sourceRange[1])
    if (chunk.text !== sourceText) {
      result.push({ ...chunk, link: { url: range.url } })
      continue
    }

    splitChunkAtLinks(chunk, sourceRange, ranges, linkIndex, result)
  }

  return result
}

function collectLinkRanges(content: string, highlights: SimpleHighlight[]): LinkRange[] {
  const ranges: LinkRange[] = []
  const explicitDestinations: LinkRange[] = []
  const labels: SourceRange[] = []
  const rawRanges: SourceRange[] = []

  for (const [start, end, group] of highlights) {
    if (group === "markup.link.label") labels.push([start, end])
    if (RAW_SCOPES.some((scope) => group === scope || group.startsWith(`${scope}.`))) rawRanges.push([start, end])
    if (!URL_SCOPES.includes(group)) continue

    const url =
      group === "markup.link.url" ? normalizeMarkdownDestination(content.slice(start, end)) : content.slice(start, end)
    if (isLinkTargetSupported(url)) explicitDestinations.push({ start, end, url })
  }

  labels.sort(compareSourceRanges)
  explicitDestinations.sort((left, right) => left.start - right.start)
  let labelIndex = 0
  let latestLabel: SourceRange | undefined
  for (const destination of explicitDestinations) {
    while (labelIndex < labels.length && labels[labelIndex][1] <= destination.start) {
      latestLabel = labels[labelIndex++]
    }
    if (latestLabel && content.slice(latestLabel[1], destination.start) === "](") {
      ranges.push({ start: latestLabel[0], end: latestLabel[1], url: destination.url })
    }
    ranges.push(destination)
    latestLabel = undefined
  }

  rawRanges.sort(compareSourceRanges)
  collectBareHttpUrls(content, rawRanges, explicitDestinations, ranges)
  ranges.sort((left, right) => left.start - right.start || left.end - right.end)
  return ranges
}

function normalizeMarkdownDestination(destination: string): string {
  let normalized = destination.trim()
  if (normalized.startsWith("<") && normalized.endsWith(">")) normalized = normalized.slice(1, -1)
  normalized = normalized.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1")
  normalized = normalized.replace(/&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot);/gi, (entity, numeric, named) => {
    if (numeric) {
      const hexadecimal = numeric[0]?.toLowerCase() === "x"
      const codePoint = Number.parseInt(hexadecimal ? numeric.slice(1) : numeric, hexadecimal ? 16 : 10)
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return entity
      return String.fromCodePoint(codePoint)
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"' }[String(named).toLowerCase()] ?? entity
  })
  try {
    return encodeURI(normalized).replace(/%25([\da-f]{2})/gi, "%$1")
  } catch {
    return ""
  }
}

function collectBareHttpUrls(
  content: string,
  rawRanges: SourceRange[],
  explicitDestinations: LinkRange[],
  ranges: LinkRange[],
): void {
  let rawIndex = 0
  let explicitIndex = 0
  let index = 0

  while (index < content.length) {
    const hasScheme = content.startsWith("http://", index) || content.startsWith("https://", index)
    const hasStartBoundary = index === 0 || !/[\p{L}\p{N}_@]/u.test(previousCodePoint(content, index))
    if (!hasScheme || !hasStartBoundary) {
      index++
      continue
    }

    while (rawIndex < rawRanges.length && rawRanges[rawIndex][1] <= index) rawIndex++
    while (explicitIndex < explicitDestinations.length && explicitDestinations[explicitIndex].end <= index)
      explicitIndex++

    let end = index
    let hasControl = false
    const nextRawStart = rawIndex < rawRanges.length ? rawRanges[rawIndex][0] : content.length
    while (end < content.length && end < nextRawStart && !isUrlBoundary(content.charCodeAt(end), content[end])) {
      if (content.charCodeAt(end) < 0x20 || content.charCodeAt(end) === 0x7f) hasControl = true
      end++
    }

    const insideRaw = rawIndex < rawRanges.length && rawRanges[rawIndex][0] <= index && index < rawRanges[rawIndex][1]
    const insideExplicit =
      explicitIndex < explicitDestinations.length &&
      explicitDestinations[explicitIndex].start <= index &&
      index < explicitDestinations[explicitIndex].end
    const trimmedEnd = trimUrlEnd(content, index, end)
    const url = content.slice(index, trimmedEnd)
    if (!hasControl && !insideRaw && !insideExplicit && isHttpUrl(url))
      ranges.push({ start: index, end: trimmedEnd, url })
    index = Math.max(end, index + 1)
  }
}

function isUrlBoundary(code: number, character: string): boolean {
  return (
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    character === "<" ||
    character === ">" ||
    character === '"' ||
    character === "'"
  )
}

function previousCodePoint(content: string, end: number): string {
  const last = content.charCodeAt(end - 1)
  const startsSurrogatePair =
    last >= 0xdc00 &&
    last <= 0xdfff &&
    end >= 2 &&
    content.charCodeAt(end - 2) >= 0xd800 &&
    content.charCodeAt(end - 2) <= 0xdbff
  return content.slice(startsSurrogatePair ? end - 2 : end - 1, end)
}

function trimUrlEnd(content: string, start: number, initialEnd: number): number {
  let end = initialEnd
  while (end > start && /[.,;:!?]/.test(content[end - 1])) end--

  for (const [open, close] of [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ] as const) {
    let balance = 0
    for (let index = start; index < end; index++) {
      if (content[index] === open) balance++
      else if (content[index] === close) balance--
    }
    while (balance < 0 && content[end - 1] === close) {
      end--
      balance++
    }
  }
  return end
}

function isHttpUrl(url: string): boolean {
  if (!isLinkTargetSupported(url)) return false
  try {
    const parsed = new URL(url)
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0
  } catch {
    return false
  }
}

function isSafeLinkTarget(url: string): boolean {
  return url.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(url)
}

export function isLinkTargetSupported(url: string): boolean {
  return isSafeLinkTarget(url) && new TextEncoder().encode(url).length <= MAX_LINK_TARGET_BYTES
}

export function normalizeMarkdownLinkTarget(destination: string): string {
  return normalizeMarkdownDestination(destination)
}

function splitChunkAtLinks(
  chunk: TextChunk,
  sourceRange: SourceRange,
  ranges: LinkRange[],
  initialRangeIndex: number,
  result: TextChunk[],
): void {
  let offset = sourceRange[0]
  let rangeIndex = initialRangeIndex
  while (offset < sourceRange[1]) {
    while (rangeIndex < ranges.length && ranges[rangeIndex].end <= offset) rangeIndex++
    const range = ranges[rangeIndex]
    if (!range || range.start >= sourceRange[1]) {
      result.push({ ...chunk, text: chunk.text.slice(offset - sourceRange[0]), link: undefined })
      return
    }
    if (offset < range.start) {
      const end = Math.min(range.start, sourceRange[1])
      result.push({ ...chunk, text: chunk.text.slice(offset - sourceRange[0], end - sourceRange[0]), link: undefined })
      offset = end
      continue
    }
    const end = Math.min(range.end, sourceRange[1])
    result.push({
      ...chunk,
      text: chunk.text.slice(offset - sourceRange[0], end - sourceRange[0]),
      link: { url: range.url },
    })
    offset = end
  }
}

function getSequentialSourceRanges(chunks: TextChunk[]): SourceRange[] {
  const ranges: SourceRange[] = []
  let offset = 0
  for (const chunk of chunks) {
    ranges.push([offset, offset + chunk.text.length])
    offset += chunk.text.length
  }
  return ranges
}

function compareSourceRanges(left: SourceRange, right: SourceRange): number {
  return left[0] - right[0] || left[1] - right[1]
}

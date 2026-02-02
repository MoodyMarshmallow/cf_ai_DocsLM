export interface ChunkingOptions {
  max_chars: number
  overlap_chars: number
  min_chars: number
}

export interface ChunkResult {
  text: string
  heading_path?: string
  chunk_index: number
  token_estimate: number
}

export function chunkText(input: string, options: ChunkingOptions): ChunkResult[] {
  const sections = splitByHeadings(input)
  const chunks: ChunkResult[] = []
  let chunkIndex = 0

  for (const section of sections) {
    const sectionChunks = recursiveSplit(section.text, options.max_chars, options.overlap_chars)
    const adjustedChunks = enforceMinChunkSize(sectionChunks, options.min_chars)
    for (const piece of adjustedChunks) {
      const tokenEstimate = estimateTokens(piece)
      chunks.push({
        text: piece,
        heading_path: section.heading,
        chunk_index: chunkIndex,
        token_estimate: tokenEstimate,
      })
      chunkIndex += 1
    }
  }

  return chunks
}

function splitByHeadings(input: string): Array<{ heading?: string; text: string }> {
  const lines = input.split("\n")
  const sections: Array<{ heading?: string; text: string }> = []
  let currentHeading: string | undefined
  let buffer: string[] = []

  for (const line of lines) {
    if (isHeadingLine(line)) {
      if (buffer.length > 0) {
        sections.push({ heading: currentHeading, text: buffer.join("\n") })
        buffer = []
      }
      currentHeading = normalizeHeading(line)
      continue
    }
    buffer.push(line)
  }

  if (buffer.length > 0) {
    sections.push({ heading: currentHeading, text: buffer.join("\n") })
  }

  if (sections.length === 0) {
    return [{ heading: undefined, text: input }]
  }

  return sections
}

function isHeadingLine(line: string): boolean {
  if (line.startsWith("#")) {
    return true
  }
  if (line.startsWith("<h1") || line.startsWith("<h2") || line.startsWith("<h3")) {
    return true
  }
  return false
}

function normalizeHeading(line: string): string {
  if (line.startsWith("#")) {
    return line.replace(/^#+\s*/, "").trim()
  }
  return line.replace(/<[^>]+>/g, "").trim()
}

function splitBySize(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars) {
    return [text]
  }

  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length)
    const slice = text.slice(start, end)
    chunks.push(slice)
    if (end === text.length) {
      break
    }
    start = end - overlapChars
    if (start < 0) {
      start = 0
    }
  }

  return chunks
}

function recursiveSplit(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars) {
    return [text]
  }

  const paragraphs = splitByParagraphs(text)
  if (paragraphs.length > 1) {
    return packSegments(paragraphs, maxChars, overlapChars)
  }

  const sentences = splitBySentences(text)
  if (sentences.length > 1) {
    return packSegments(sentences, maxChars, overlapChars)
  }

  return splitBySize(text, maxChars, overlapChars)
}

function splitByParagraphs(text: string): string[] {
  const parts = text.split(/\n\s*\n+/)
  return parts.map(function (part) {
    return part.trim()
  }).filter(function (part) {
    return part.length > 0
  })
}

function splitBySentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+/)
  return parts.map(function (part) {
    return part.trim()
  }).filter(function (part) {
    return part.length > 0
  })
}

function packSegments(segments: string[], maxChars: number, overlapChars: number): string[] {
  const packed: string[] = []
  let buffer = ""

  for (const segment of segments) {
    if (!buffer) {
      buffer = segment
      continue
    }

    if (buffer.length + segment.length + 1 <= maxChars) {
      buffer = buffer + "\n" + segment
      continue
    }

    packed.push(buffer)
    buffer = applyOverlap(buffer, segment, overlapChars, maxChars)
  }

  if (buffer) {
    packed.push(buffer)
  }

  return packed
}

function applyOverlap(previous: string, next: string, overlapChars: number, maxChars: number): string {
  if (overlapChars <= 0) {
    return next
  }

  const overlap = previous.slice(Math.max(0, previous.length - overlapChars))
  if (overlap.length + next.length + 1 <= maxChars) {
    return overlap + "\n" + next
  }

  return next
}

function enforceMinChunkSize(chunks: string[], minChars: number): string[] {
  if (chunks.length <= 1) {
    return chunks
  }

  const merged: string[] = []
  let buffer = ""

  for (const chunk of chunks) {
    if (!buffer) {
      buffer = chunk
      continue
    }

    if (buffer.length < minChars) {
      buffer = buffer + "\n\n" + chunk
      continue
    }

    merged.push(buffer)
    buffer = chunk
  }

  if (buffer) {
    if (merged.length > 0 && buffer.length < minChars) {
      const lastIndex = merged.length - 1
      merged[lastIndex] = merged[lastIndex] + "\n\n" + buffer
    } else {
      merged.push(buffer)
    }
  }

  return merged
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

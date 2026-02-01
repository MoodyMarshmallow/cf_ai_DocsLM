export interface ChunkingOptions {
  max_chars: number
  overlap_chars: number
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
    const sectionChunks = splitBySize(section.text, options.max_chars, options.overlap_chars)
    for (const piece of sectionChunks) {
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

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

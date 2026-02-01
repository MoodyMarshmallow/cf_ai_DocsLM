export function normalizeHtmlToText(html: string): string {
  let text = html
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "")
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "")
  text = text.replace(/<[^>]+>/g, " ")
  text = text.replace(/\s+/g, " ")
  return text.trim()
}

export function normalizeMarkdownToText(markdown: string): string {
  return markdown.trim()
}

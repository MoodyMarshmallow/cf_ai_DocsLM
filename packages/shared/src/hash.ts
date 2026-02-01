export async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(input)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  let hex = ""
  for (const value of hashArray) {
    hex += value.toString(16).padStart(2, "0")
  }
  return hex
}

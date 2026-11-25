/** Quote one argv field for Windows native programs and Start-Process. */
export function quoteWindowsArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
}

export const windowsCommandLine = (args: readonly string[]): string => args.map(quoteWindowsArgument).join(' ')

/** Read Windows backslash/double-quote rules, preserving the historical single-quote shorthand. */
export function splitArgs(input: string): string[] {
  const values: string[] = []
  let index = 0
  while (index < input.length) {
    while (index < input.length && /[ \t]/.test(input[index])) index++
    if (index === input.length) break
    let value = ''
    let quote: '"' | "'" | null = null
    while (index < input.length) {
      const next = input[index]
      if (!quote && /[ \t]/.test(next)) break
      if (next === "'" && quote !== '"') {
        quote = quote ? null : "'"
        index++
        continue
      }
      if (quote !== "'" && (next === '\\' || next === '"')) {
        let slashes = 0
        while (input[index] === '\\') {
          slashes++
          index++
        }
        if (input[index] === '"') {
          value += '\\'.repeat(Math.floor(slashes / 2))
          if (slashes % 2 || (quote === '"' && input[index + 1] === '"')) {
            value += '"'
            if (slashes % 2 === 0) index++
          } else quote = quote ? null : '"'
          index++
        } else value += '\\'.repeat(slashes)
        continue
      }
      value += next
      index++
    }
    values.push(value)
  }
  return values
}

export type Section = { header: string; items: string[][]; gap: string; rest?: string }

export function clip(text: string, length: number) {
  const first = text.trim().split('\n')[0]!
  return first.length > length ? `${first.slice(0, length - 1)}…` : first
}

const more = ({ gap, rest }: Section, left: number) => `${gap}…and ${left} more${rest ? `: ${rest}` : ''}`

// Each item in the first of its forms that still fits, and a line for the ones that didn't, within
// room: an item goes in only if the lines that would still follow it fit too. With no room, it's
// the least the sections can take: their headers and a line counting each one's items.
export function fit(sections: Section[], room: number): string {
  const shown = sections.filter(section => section.items.length)
  const least = shown.map((section, n) => (n ? 2 : 0) + section.header.length + more(section, section.items.length).length)
  let text = ''
  shown.forEach((section, n) => {
    const after = least.slice(n + 1).reduce((sum, length) => sum + length, 0)
    const { header, items, gap } = section
    text += `${text && '\n\n'}${header}`
    const left = items.findIndex((forms, i) => {
      const owed = after + (i < items.length - 1 ? more(section, items.length - i - 1).length : 0)
      const form = forms.find(form => text.length + gap.length + form.length + owed <= room)
      if (form === undefined) return true
      text += gap + form
      return false
    })
    if (left >= 0) text += more(section, items.length - left)
  })
  return text
}

// Claude Code puts at most 10,000 characters of a hook's output into context and swaps the rest for
// a path and a preview it doesn't ask Claude to read (https://code.claude.com/docs/en/hooks#json-output),
// so a hook's output stays under ROOM, which leaves space for the lines around it.
export const ROOM = 9_000

// Text split at line ends into parts that each fit a hook.
export function split(text: string, room = ROOM) {
  const parts = ['']
  for (const line of text.replace(/\n$/, '').split('\n')) {
    if (parts.at(-1) && parts.at(-1)!.length + line.length + 1 > room) parts.push('')
    parts[parts.length - 1] += `${line}\n`
  }
  return parts
}

// What the nth of a run of hooks puts into context when they hand over parts that together don't fit
// one: its part under the lead, and from the last hook, where to find the parts left over. The hooks
// run at once and each makes its own copy, so each part names its copy, and `whole` says where a
// whole one is when the text changed between them.
export function handover(parts: string[], n: number, last: boolean, lead: string, whole: string) {
  const part = parts[n - 1]
  if (!part?.trim()) return ''
  if (parts.length === 1) return `${lead}\n\n${part}`
  const copy = Bun.hash(parts.join('')).toString(36).slice(0, 6)
  const more = last && parts.length > n ? `\nThat's all the hooks can show. ${whole}\n` : ''
  return `${lead} This comes in ${parts.length} parts of copy ${copy}, which may arrive out of order; this is part ${n}. Read them in order. If a part names another copy, the text changed while they were made: ${whole}\n\n${part}${more}`
}

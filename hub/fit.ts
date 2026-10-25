export type Section = { header: string; items: string[][]; gap: string; rest?: string }

export function clip(text: string, length: number) {
  const first = text.trim().split('\n')[0]!
  return first.length > length ? `${first.slice(0, length - 1)}…` : first
}

const more = ({ gap, rest }: Section, left: number) => `${gap}…and ${left} more${rest ? `: ${rest}` : ''}`

// Each item in the first of its forms that still fits, and a line for the ones that didn't, within
// room: an item goes in only if the lines that would still follow it fit too. With no room, it's
// the least the sections can take: their headers and a line counting each one's items. A section
// with no items is its header alone.
export function fit(sections: Section[], room: number): string {
  const least = sections.map((section, n) => (n ? 2 : 0) + section.header.length + (section.items.length ? more(section, section.items.length).length : 0))
  let text = ''
  sections.forEach((section, n) => {
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

// A status post's words above its first 🔴 Blocked on you, 🟡 Pending or 🟢 Done heading: its note.
export function above(text: string) {
  const lines = text.split('\n')
  const first = lines.findIndex(line => /^\s*(\*\*)?(🔴|🟡|🟢)\s*(\*\*)?\s*(Blocked on you|Pending|Done)\b/u.test(line))
  return (first < 0 ? lines : lines.slice(0, first)).join('\n').trim()
}

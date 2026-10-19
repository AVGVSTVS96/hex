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

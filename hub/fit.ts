export type Section = { header: string; items: string[][]; gap: string; rest?: string };

export function clip(text: string, length: number) {
  const first = text.trim().split("\n")[0] ?? "";

  return first.length > length ? `${first.slice(0, length - 1)}…` : first;
}

const more = ({ gap, rest }: Section, left: number) =>
  `${gap}…and ${left} more${rest === undefined || rest === "" ? "" : `: ${rest}`}`;

export function fit(sections: Section[], room: number): string {
  const headersAndCounts = sections.map(
    (section, n) =>
      (n === 0 ? 0 : 2) +
      section.header.length +
      (section.items.length > 0 ? more(section, section.items.length).length : 0),
  );

  let text = "";
  sections.forEach((section, n) => {
    const after = headersAndCounts.slice(n + 1).reduce((sum, length) => sum + length, 0);
    const { header, items, gap } = section;
    text += `${text && "\n\n"}${header}`;

    const left = items.findIndex((forms, i) => {
      const owed = after + (i < items.length - 1 ? more(section, items.length - i - 1).length : 0);

      const firstThatFits = forms.find(
        (form) => text.length + gap.length + form.length + owed <= room,
      );

      if (firstThatFits === undefined) {
        return true;
      }

      text += gap + firstThatFits;

      return false;
    });

    if (left !== -1) {
      text += more(section, items.length - left);
    }
  });

  return text;
}

// Claude Code swaps hook output past 10,000 characters for an unread file path, so ROOM leaves space for the lines around it: https://code.claude.com/docs/en/hooks#json-output
export const ROOM = 9000;

export const HEADINGS = ["Waiting on you", "Open", "Ideas", "Done"] as const;

const BEFORE_PLAIN_HEADINGS =
  /^\s*(#+\s*)?(\*\*)?(🔴|🟡|🟢)\s*(\*\*)?\s*(Blocked on you|Pending|Done)\b/u;

export function above(text: string) {
  const lines = text.split("\n");

  const first = lines.findIndex(
    (line) =>
      BEFORE_PLAIN_HEADINGS.test(line) ||
      HEADINGS.some((heading) => line.trim() === `**${heading}**`),
  );

  return (first === -1 ? lines : lines.slice(0, first)).join("\n").trim();
}

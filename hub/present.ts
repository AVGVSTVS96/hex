export function present(text: string | undefined): text is string {
  return text !== undefined && text !== "";
}

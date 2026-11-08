#!/usr/bin/env bun
import { join, relative, resolve } from 'path'
import { loaded } from '../hub/loaded.ts'

export { loaded }

if (import.meta.main) {
  const home = resolve(process.argv[2] ?? join(import.meta.dir, '../..'))
  const files = loaded(join(home, 'AGENTS.md')).map(([file, text]) => `── ${relative(home, file)} ──\n${text.trim()}`)

  console.log(`You are hex, working in ${process.cwd()} instead of your own folder, ${home}. Your instructions below come from there, and every path in them is relative to it: \`.hex/vendor/memo\` is \`${home}/.hex/vendor/memo\`, and the files you keep and commit (AGENTS.md, schedules.json) live there too.

${files.join('\n\n')}`)
}

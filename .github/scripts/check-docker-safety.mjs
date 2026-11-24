import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const textExtensions = new Set(['.js', '.json', '.md', '.mjs', '.sh', '.ts', '.yml', '.yaml'])
const composeFileNames = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']

function logicalCommands(lines) {
  const commands = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1
    let command = lines[index]
    while (command.trimEnd().endsWith('\\') && index + 1 < lines.length) {
      command = `${command.trimEnd().slice(0, -1)} ${lines[++index]}`
    }
    commands.push({ line, text: command })
  }

  return commands
}

function hasJobLabelFilter(command) {
  const filter = /--filter(?:=|\s+)["']?label=([\w.-]*(?:task|job|run)[\w.-]*(?:=|:)[^,"'\s]*)/gi
  for (const match of command.matchAll(filter)) {
    if (/(?:GITHUB_RUN_ID|GITHUB_RUN_ATTEMPT|GITHUB_JOB|TASK_ID|RUN_ID|JOB_ID|github\.run_id)/i.test(match[1])) {
      return true
    }
  }
  return false
}

function hasFixedDockerPublish(command) {
  return /(?:^|\s)(?:--publish(?:=|\s+)|-p(?:=|\s+|(?=\d)))(?:(?:(?:\d{1,3}\.){3}\d{1,3}|localhost|\[[\da-f:]+\]):)?\d+(?:-\d+)?:\d+(?:-\d+)?(?:\/(?:tcp|udp))?(?=$|\s|["'])/.test(command)
}

function hasFixedPortMapping(value) {
  return /(?:\d{1,3}(?:\.\d{1,3}){3}|localhost|\[[\da-f:]+\]):\d+(?:-\d+)?:\d+(?:-\d+)?|\d+(?:-\d+)?:\d+(?:-\d+)?/.test(
    value,
  )
}

export function findDockerSafetyViolations(source, file = '<input>') {
  const lines = source.split(/\r?\n/)
  const violations = []

  for (const command of logicalCommands(lines)) {
    if (hasFixedDockerPublish(command.text)) {
      violations.push({ file, line: command.line, message: 'fixed host-port publishing' })
    }

    if (
      /\bdocker\s+(?:system|container|image|volume|network|builder)\s+prune\b/i.test(command.text) &&
      !hasJobLabelFilter(command.text)
    ) {
      violations.push({ file, line: command.line, message: 'unfiltered Docker prune' })
    }

    if (/\bdocker\s+rm\b[\s\S]*?(?:--force|(?:^|\s)-[a-z]*f[a-z]*)[\s\S]*?\bdocker\s+ps\b[\s\S]*?-aq\b/i.test(command.text)) {
      violations.push({ file, line: command.line, message: 'removing every Docker container' })
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)ports:\s*(.*)$/)
    if (!match) continue

    const indent = match[1].length
    let block = match[2]
    for (let next = index + 1; next < lines.length; next += 1) {
      if (!lines[next].trim()) continue
      const nextIndent = lines[next].match(/^\s*/)[0].length
      if (nextIndent <= indent) break
      block += `\n${lines[next]}`
    }

    if (hasFixedPortMapping(block) || /^\s*published:\s*["']?\d+/m.test(block)) {
      violations.push({ file, line: index + 1, message: 'fixed host-port publishing' })
    }
  }

  return violations
}

async function listTextFiles(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listTextFiles(path)))
    } else if (entry.isFile() && textExtensions.has(extname(path))) {
      files.push(path)
    }
  }
  return files
}

function isInScopeWorkflow(source) {
  return /\b(?:inference-x64|ubuntu-latest)\b/.test(source)
}

function composeFileReferences(source) {
  if (!/\bdocker\s+compose\b|\bdocker-compose\b/.test(source)) return []

  const references = []
  const fileOption = /(?:--file(?:=|\s+)|(?:^|\s)-f(?:=|\s+))(["']?)([^\s"'\\]+)/g
  for (const match of source.matchAll(fileOption)) references.push(match[2])
  return references
}

async function collectComposeFiles(root, sources) {
  const references = new Set()
  const defaultDirectories = new Set()

  for (const { path, source } of sources) {
    if (!/\bdocker\s+compose\b|\bdocker-compose\b/.test(source)) continue
    defaultDirectories.add(root)
    for (const match of source.matchAll(/^\s*working-directory:\s*["']?([^\s"']+)/gm)) {
      defaultDirectories.add(resolve(root, match[1]))
    }
    for (const reference of composeFileReferences(source)) {
      references.add(resolve(root, reference))
    }
  }

  for (const directory of defaultDirectories) {
    for (const name of composeFileNames) references.add(join(directory, name))
  }

  const found = []
  for (const path of references) {
    try {
      found.push({ path, source: await readFile(path, 'utf8') })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return found
}

async function main() {
  const root = process.cwd()
  const githubFiles = await listTextFiles(join(root, '.github'))
  const giteaFiles = await listTextFiles(join(root, '.gitea'))
  const configFiles = [...githubFiles, ...giteaFiles].filter(path => !/\.test\.[^.]+$/.test(path))
  const sources = await Promise.all(
    configFiles.map(async path => ({ path, source: await readFile(path, 'utf8') })),
  )
  const scopedWorkflows = sources.filter(({ path, source }) =>
    /[\\/](?:workflows)[\\/][^\\/]+\.ya?ml$/.test(path) && isInScopeWorkflow(source),
  )
  const helperSources = sources.filter(({ path }) => /[\\/](?:actions|scripts)[\\/]/.test(path))
  const composeFiles = await collectComposeFiles(root, [...scopedWorkflows, ...helperSources])
  const scanned = new Map([...scopedWorkflows, ...helperSources, ...composeFiles].map(item => [item.path, item]))
  const violations = [...scanned.values()].flatMap(({ path, source }) =>
    findDockerSafetyViolations(source, relative(root, path)),
  )

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.file}:${violation.line}: ${violation.message}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`Docker workflow safety passed (${scanned.size} files checked)`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main()

import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const textExtensions = new Set(['.js', '.json', '.md', '.mjs', '.sh', '.ts', '.yml', '.yaml'])
const composeFileNames = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
]

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
  const filter = /--filter(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi
  const hasVariable = (value, name) => {
    const patterns = [`\\$\\{\\{\\s*(?:env\\.)?${name}\\s*\\}\\}`, `\\$\\{${name}\\}`, `\\$${name}`]
    const githubContext = {
      GITHUB_JOB: 'github.job',
      GITHUB_RUN_ATTEMPT: 'github.run_attempt',
      GITHUB_RUN_ID: 'github.run_id',
    }[name]
    if (githubContext) patterns.push(`\\$\\{\\{\\s*${githubContext}\\s*\\}\\}`)
    return new RegExp(`(?:${patterns.join('|')})(?![\\w])`, 'i').test(value)
  }

  for (const match of command.matchAll(filter)) {
    const criterion = match[1] ?? match[2] ?? match[3]
    const label = criterion.match(/^label=([\w.-]+)=(.+)$/i)
    if (!label || !/(?:task|job|run)/i.test(label[1])) continue

    const value = label[2].trim()
    if (
      ['TASK_ID', 'GITEA_TASK_ID', 'RUNNER_TASK_ID', 'CI_JOB_ID', 'GITHUB_JOB_ID'].some(name =>
        hasVariable(value, name),
      )
    ) {
      return true
    }

    const runIdentity = ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB'].every(name =>
      hasVariable(value, name),
    )
    const matrixIdentity =
      /\$\{\{\s*matrix\.[\w.-]+\s*\}\}/i.test(value) || /\$\{?MATRIX_[A-Z0-9_]+\}?/i.test(value)
    if (runIdentity && matrixIdentity) return true
  }
  return false
}

function hasFixedDockerPublish(command) {
  return /(?:^|\s)(?:--publish(?:=|\s+)|-p(?:=|\s+|(?=\d)))["']?(?:(?:(?:\d{1,3}\.){3}\d{1,3}|localhost|\[[\da-f:]+\]):)?\d+(?:-\d+)?:\d+(?:-\d+)?(?:\/(?:tcp|udp))?(?=$|\s|["'])/.test(
    command,
  )
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
      /\bdocker\s+(?:system|container|image|volume|network|builder)\s+prune\b/i.test(
        command.text,
      ) &&
      !hasJobLabelFilter(command.text)
    ) {
      violations.push({ file, line: command.line, message: 'unfiltered Docker prune' })
    }

    if (
      /\bdocker\s+rm\b[\s\S]*?(?:--force|(?:^|\s)-[a-z]*f[a-z]*)[\s\S]*?\bdocker\s+ps\b[\s\S]*?-aq\b/i.test(
        command.text,
      )
    ) {
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
  const fileOption = /(?:--file(?:=|\s+)|(?:^|\s)-f(?:=|\s+))(?:"([^"]+)"|'([^']+)'|([^\s"'\\]+))/g
  for (const match of source.matchAll(fileOption)) references.push(match[1] ?? match[2] ?? match[3])
  return references
}

function workflowSteps(source) {
  const lines = source.split(/\r?\n/)
  const steps = []

  for (let index = 0; index < lines.length; index += 1) {
    const stepsMatch = lines[index].match(/^(\s*)steps:\s*$/)
    if (!stepsMatch) continue

    const stepsIndent = stepsMatch[1].length
    const stepIndent = stepsIndent + 2
    let block = []
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (line.trim() && line.match(/^\s*/)[0].length <= stepsIndent) break

      const indent = line.match(/^\s*/)[0].length
      if (line.trim() && indent === stepIndent && /^\s*-\s*/.test(line)) {
        if (block.length > 0) steps.push(block)
        block = [line.replace(/^\s*-\s?/, '')]
      } else if (block.length > 0) {
        block.push(line)
      }
    }
    if (block.length > 0) steps.push(block)
  }

  return steps.map(linesInStep => {
    const stepSource = linesInStep.join('\n')
    const workingDirectory = stepSource.match(/^\s*working-directory:\s*(.*?)\s*$/m)?.[1]
    return {
      source: stepSource,
      workingDirectory: workingDirectory?.replace(/^['"]|['"]$/g, ''),
    }
  })
}

function defaultComposePaths(root, workingDirectory) {
  const paths = []
  let directory = workingDirectory
  while (true) {
    for (const name of composeFileNames) paths.push(join(directory, name))
    if (directory === root) break
    const parent = dirname(directory)
    if (parent === directory || relative(root, parent).startsWith('..')) break
    directory = parent
  }
  return paths
}

export async function collectComposeFiles(root, sources) {
  const references = new Set()

  for (const { path, source } of sources) {
    if (!/\bdocker\s+compose\b|\bdocker-compose\b/.test(source)) continue

    const isWorkflow = /[\\/]workflows[\\/][^\\/]+\.ya?ml$/.test(path)
    const commands = isWorkflow
      ? workflowSteps(source).filter(step =>
          /\bdocker\s+compose\b|\bdocker-compose\b/.test(step.source),
        )
      : [{ source, workingDirectory: undefined }]

    for (const command of commands) {
      const workingDirectory = resolve(root, command.workingDirectory || '.')
      const fileReferences = composeFileReferences(command.source)
      if (fileReferences.length > 0) {
        for (const reference of fileReferences) references.add(resolve(workingDirectory, reference))
      } else {
        for (const path of defaultComposePaths(root, workingDirectory)) references.add(path)
      }
    }
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
  const scopedWorkflows = sources.filter(
    ({ path, source }) =>
      /[\\/](?:workflows)[\\/][^\\/]+\.ya?ml$/.test(path) && isInScopeWorkflow(source),
  )
  const helperSources = sources.filter(({ path }) => /[\\/](?:actions|scripts)[\\/]/.test(path))
  const composeFiles = await collectComposeFiles(root, [...scopedWorkflows, ...helperSources])
  const scanned = new Map(
    [...scopedWorkflows, ...helperSources, ...composeFiles].map(item => [item.path, item]),
  )
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

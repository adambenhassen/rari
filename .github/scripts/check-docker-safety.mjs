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
const composeSubcommands = new Set([
  'alpha',
  'attach',
  'build',
  'config',
  'convert',
  'cp',
  'create',
  'down',
  'events',
  'exec',
  'images',
  'kill',
  'logs',
  'ls',
  'pause',
  'port',
  'ps',
  'pull',
  'push',
  'restart',
  'rm',
  'run',
  'start',
  'stop',
  'top',
  'unpause',
  'up',
  'version',
  'wait',
  'watch',
])
const composeGlobalOptionsWithValue = new Set([
  '--ansi',
  '--context',
  '--env-file',
  '--host',
  '--log-level',
  '--parallel',
  '--profile',
  '--project-directory',
  '--project-name',
  '--progress',
  '-c',
  '-H',
  '-p',
])
const dockerRootOptionsWithValue = new Set([
  '--config',
  '--context',
  '--host',
  '--log-level',
  '--tlscacert',
  '--tlscert',
  '--tlskey',
  '-c',
  '-H',
  '-l',
])
const dockerRootOptionsWithoutValue = new Set([
  '--debug',
  '--help',
  '--tls',
  '--tlsverify',
  '--version',
  '-D',
])

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

function shellTokens(source) {
  return [...source.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g)].map(match => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }))
}

function unquoteShellToken(token) {
  return (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
    ? token.slice(1, -1)
    : token
}

function commandWord(token) {
  return unquoteShellToken(token)
    .replace(/^[($`]+|[);`]+$/g, '')
    .toLowerCase()
}

function dockerInvocations(source) {
  const matches = [...source.matchAll(/\bdocker(?=\s|$|-compose\b)/gi)]
  const invocations = []

  for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
    const match = matches[matchIndex]
    const end = matches[matchIndex + 1]?.index ?? source.length
    const afterDocker = match.index + match[0].length
    const tokens = shellTokens(source.slice(afterDocker, end))

    for (let index = 0; index < tokens.length; index += 1) {
      const token = commandWord(tokens[index].value)

      if (token === '-compose') {
        invocations.push({
          subcommand: 'compose',
          arguments: source.slice(afterDocker + tokens[index].end, end),
          command: source.slice(match.index, end),
        })
        break
      }

      if (dockerRootOptionsWithValue.has(token)) {
        if (!tokens[index + 1]) break
        index += 1
        continue
      }

      const attachedValueOption = [...dockerRootOptionsWithValue].some(
        option =>
          token.startsWith(`${option}=`) ||
          (option.length === 2 &&
            option.startsWith('-') &&
            token.startsWith(option) &&
            token.length > 2),
      )
      if (
        attachedValueOption ||
        dockerRootOptionsWithoutValue.has(token) ||
        token.startsWith('-')
      ) {
        continue
      }

      invocations.push({
        subcommand: token,
        arguments: source.slice(afterDocker + tokens[index].end, end),
        command: source.slice(match.index, end),
      })
      break
    }
  }

  return invocations
}

function removesEveryDockerContainer(invocations) {
  const forceRemove = invocations.some(
    invocation =>
      invocation.subcommand === 'rm' &&
      /(?:^|\s)(?:--force|-[a-z]*f[a-z]*)(?:\s|$)/i.test(invocation.arguments),
  )
  const listsEveryContainer = invocations.some(
    invocation =>
      invocation.subcommand === 'ps' && /(?:^|\s)-[a-z]*aq\b/i.test(invocation.arguments),
  )
  return forceRemove && listsEveryContainer
}

function hasVariable(value, name) {
  const patterns = [`\\$\\{\\{\\s*(?:env\\.)?${name}\\s*\\}\\}`, `\\$\\{${name}\\}`, `\\$${name}`]
  const githubContext = {
    GITHUB_JOB: 'github.job',
    GITHUB_RUN_ATTEMPT: 'github.run_attempt',
    GITHUB_RUN_ID: 'github.run_id',
  }[name]
  if (githubContext) patterns.push(`\\$\\{\\{\\s*${githubContext}\\s*\\}\\}`)
  const variable = new RegExp(`(?:${patterns.join('|')})(?![\\w])`, 'gi')
  for (const match of value.matchAll(variable)) {
    let backslashes = 0
    for (let index = match.index - 1; index >= 0 && value[index] === '\\'; index -= 1) {
      backslashes += 1
    }
    if (backslashes % 2 === 0) return true
  }
  return false
}

function hasMatrixField(value, field) {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matrixExpression = new RegExp(`\\$\\{\\{\\s*matrix\\.${escapedField}\\s*\\}\\}`, 'i')
  const envName = `MATRIX_${field.replace(/[^a-z\d_]/gi, '_').toUpperCase()}`
  return matrixExpression.test(value) || hasVariable(value, envName)
}

function hasFullMatrixExpression(value) {
  return /\$\{\{\s*toJSON\s*\(\s*matrix\s*\)\s*\}\}/i.test(value)
}

function assignedShellVariableValue(source, reference) {
  const variable = reference.match(/^\$\{?([A-Za-z_][\w]*)\}?$/)
  if (!variable) return { value: reference, expandsVariables: true, assignments: [] }

  const name = variable[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const assignmentPattern = new RegExp(
    `^\\s*(?:export\\s+)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]+))\\s*(?:#.*)?$`,
    'gm',
  )
  const assignments = [...source.matchAll(assignmentPattern)].map(assignment => {
    if (assignment[1] !== undefined) return { value: assignment[1], expandsVariables: true }
    if (assignment[2] !== undefined) return { value: assignment[2], expandsVariables: false }
    return { value: assignment[3], expandsVariables: true }
  })
  return assignments.length > 0
    ? { ...assignments[0], assignments }
    : { value: reference, expandsVariables: true, assignments: [] }
}

function hasJobScopedContainerName(name, matrixContext) {
  const runIdentity = ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB'].every(variable =>
    hasVariable(name, variable),
  )
  const matrixIdentity = matrixContext
    ? !matrixContext.hasMatrix ||
      hasFullMatrixExpression(name) ||
      (!matrixContext.hasUnknownDimensions &&
        matrixContext.keys.every(key => hasMatrixField(name, key)))
    : true
  return runIdentity && matrixIdentity
}

function dockerContainerName(command, source) {
  const match = /(?:^|\s)--name(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s]+))/i.exec(command)
  if (!match) return undefined
  const expandsVariables = match[2] === undefined
  const name = assignedShellVariableValue(source, match[1] ?? match[2] ?? match[3])
  return { ...name, expandsVariables: expandsVariables && name.expandsVariables }
}

function hasJobLabelFilter(command, matrixContext) {
  const filter = /--filter(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi

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
    const matrixIdentity = matrixContext
      ? !matrixContext.hasMatrix ||
        hasFullMatrixExpression(value) ||
        (matrixContext.keys.length > 0 &&
          !matrixContext.hasUnknownDimensions &&
          matrixContext.keys.every(key => hasMatrixField(value, key)))
      : hasFullMatrixExpression(value)
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

function workflowMatrixContext(source) {
  const lines = source.split(/\r?\n/)
  const keys = new Set()
  let hasMatrix = false
  let hasUnknownDimensions = false

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)matrix:\s*(.*?)\s*$/)
    if (!match) continue

    hasMatrix = true
    const matrixIndent = match[1].length
    if (match[2] && !match[2].startsWith('#')) {
      hasUnknownDimensions = true
      continue
    }

    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (!line.trim() || line.trimStart().startsWith('#')) continue
      const indent = line.match(/^\s*/)[0].length
      if (indent <= matrixIndent) break
      if (indent !== matrixIndent + 2) continue

      const dimension = line.trim().match(/^([\w-]+):(?:\s|$)/)
      if (!dimension || dimension[1] === 'exclude') continue
      if (dimension[1] !== 'include') {
        keys.add(dimension[1])
        continue
      }

      if (line.trim().slice('include:'.length).trim()) {
        hasUnknownDimensions = true
        continue
      }

      let includeFields = 0
      for (let includeLine = next + 1; includeLine < lines.length; includeLine += 1) {
        const included = lines[includeLine]
        if (!included.trim() || included.trimStart().startsWith('#')) continue
        const includeIndent = included.match(/^\s*/)[0].length
        if (includeIndent <= indent) break

        const includedDimension = included.trim().match(/^(?:-\s*)?([\w-]+):(?:\s|$)/)
        if (includedDimension) {
          keys.add(includedDimension[1])
          includeFields += 1
        }
      }
      if (includeFields === 0) hasUnknownDimensions = true
    }
  }

  return { hasMatrix, hasUnknownDimensions, keys: [...keys] }
}

export function findDockerSafetyViolations(source, file = '<input>') {
  const lines = source.split(/\r?\n/)
  const violations = []
  const isWorkflow = /[\\/]workflows[\\/][^\\/]+\.ya?ml$/.test(file)
  const matrixContext = isWorkflow ? workflowMatrixContext(source) : undefined

  for (const command of logicalCommands(lines)) {
    const invocations = dockerInvocations(command.text)

    for (const invocation of invocations) {
      if (invocation.subcommand === 'create' || invocation.subcommand === 'run') {
        const name = dockerContainerName(invocation.command, source)
        const hasUnscopedAssignment = name?.assignments.some(
          assignment =>
            !assignment.expandsVariables ||
            !hasJobScopedContainerName(assignment.value, matrixContext),
        )
        if (
          !name ||
          !name.expandsVariables ||
          !hasJobScopedContainerName(name.value, matrixContext) ||
          hasUnscopedAssignment
        ) {
          violations.push({
            file,
            line: command.line,
            message: 'container name is not unique to this job',
          })
        }
      }

      if (hasFixedDockerPublish(invocation.command)) {
        violations.push({ file, line: command.line, message: 'fixed host-port publishing' })
      }

      if (
        /^(?:system|container|image|volume|network|builder)\s+prune\b/i.test(
          `${invocation.subcommand}${invocation.arguments}`,
        ) &&
        !hasJobLabelFilter(`${invocation.subcommand}${invocation.arguments}`, matrixContext)
      ) {
        violations.push({ file, line: command.line, message: 'unfiltered Docker prune' })
      }
    }

    if (removesEveryDockerContainer(invocations)) {
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

function normalizeShellContinuations(source) {
  return source.replace(/\\(?:\r\n|\n|\r)[\t ]*/g, ' ')
}

function hasDockerComposeCommand(source) {
  return dockerInvocations(normalizeShellContinuations(source)).some(
    invocation => invocation.subcommand === 'compose',
  )
}

function shellCommandSegments(source) {
  source = normalizeShellContinuations(source)
  const segments = []
  let current = ''
  let quote
  let escaped = false
  let wordStarted = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (escaped) {
      current += character
      escaped = false
      wordStarted = true
      continue
    }
    if (character === '\\' && quote !== "'") {
      current += character
      escaped = true
      wordStarted = true
      continue
    }
    if (quote) {
      current += character
      if (character === quote) quote = undefined
      wordStarted = true
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      current += character
      wordStarted = true
      continue
    }
    if (character === '#' && !wordStarted) {
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        index += 1
      }
      segments.push(current)
      current = ''
      wordStarted = false
      continue
    }
    if (character === '\n' || character === '\r' || character === ';' || character === '|') {
      segments.push(current)
      current = ''
      wordStarted = false
      if (character === '|' && source[index + 1] === '|') index += 1
      continue
    }
    if (character === '&') {
      segments.push(current)
      current = ''
      wordStarted = false
      if (source[index + 1] === '&') index += 1
      continue
    }
    if (/\s/.test(character)) wordStarted = false
    else wordStarted = true
    current += character
  }

  segments.push(current)
  return segments
}

function composeFileReferences(source) {
  const references = []

  for (const segment of shellCommandSegments(source)) {
    for (const command of dockerInvocations(segment)) {
      if (command.subcommand !== 'compose') continue

      const tokens = shellTokens(command.arguments)
      for (let index = 0; index < tokens.length; index += 1) {
        const token = unquoteShellToken(tokens[index].value)
        const word = commandWord(tokens[index].value)
        if (composeSubcommands.has(word)) break

        let reference

        if (token === '-f' || token === '--file') {
          if (!tokens[index + 1]) {
            throw new Error(`Cannot statically resolve explicit Compose file option in ${segment}`)
          }
          reference = unquoteShellToken(tokens[++index].value)
        } else if (token.startsWith('--file=')) {
          reference = token.slice('--file='.length)
        } else if (token.startsWith('--file')) {
          throw new Error(
            `Cannot statically resolve explicit Compose file option "${token}" in ${segment}`,
          )
        } else if (token.startsWith('-f') && token.length > 2) {
          reference = token.slice(2).replace(/^=/, '')
        } else if (composeGlobalOptionsWithValue.has(token)) {
          if (!tokens[index + 1]) {
            throw new Error(`Cannot statically resolve Compose option "${token}" in ${segment}`)
          }
          index += 1
        } else if (token.startsWith('-')) {
          continue
        } else {
          continue
        }

        if (reference !== undefined) {
          if (!reference) {
            throw new Error(`Cannot statically resolve explicit Compose file option in ${segment}`)
          }
          references.push(reference)
        }
      }
    }
  }
  return references
}

function isLiteralComposeFileReference(reference) {
  return !/[$`*?]/.test(reference)
}

function yamlScalar(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0]
    const end = trimmed.lastIndexOf(quote)
    if (
      end > 0 &&
      (end === trimmed.length - 1 ||
        trimmed
          .slice(end + 1)
          .trimStart()
          .startsWith('#'))
    ) {
      return trimmed.slice(1, end)
    }
  }
  return trimmed.replace(/\s+#.*$/, '')
}

function yamlEnvironment(lines, start, end, environmentIndent) {
  const environment = {}

  for (let index = start; index < end; index += 1) {
    const match = lines[index].match(/^(\s*)env:\s*(?:#.*)?$/)
    if (!match || match[1].length !== environmentIndent) continue

    for (let next = index + 1; next < end; next += 1) {
      const line = lines[next]
      if (line.trim() && line.match(/^\s*/)[0].length <= environmentIndent) break
      const variable = line.match(/^\s*["']?([A-Za-z_][\w-]*)["']?:\s*(.*?)\s*$/)
      if (variable && line.match(/^\s*/)[0].length === environmentIndent + 2) {
        environment[variable[1]] = yamlScalar(variable[2])
      }
    }
  }

  return environment
}

function defaultRunWorkingDirectory(lines, start, end, defaultsIndent) {
  for (let index = start; index < end; index += 1) {
    const defaultsMatch = lines[index].match(/^(\s*)defaults:\s*(?:#.*)?$/)
    if (!defaultsMatch || defaultsMatch[1].length !== defaultsIndent) continue

    for (let next = index + 1; next < end; next += 1) {
      const line = lines[next]
      if (line.trim() && line.match(/^\s*/)[0].length <= defaultsIndent) break
      const indent = line.match(/^\s*/)[0].length
      if (indent !== defaultsIndent + 2 || !/^\s*run:\s*(?:#.*)?$/.test(line)) continue

      for (let runLine = next + 1; runLine < end; runLine += 1) {
        const runLineText = lines[runLine]
        if (runLineText.trim() && runLineText.match(/^\s*/)[0].length <= indent) break
        const workingDirectory = runLineText.match(/^\s*working-directory:\s*(.*?)\s*$/)
        if (workingDirectory) return yamlScalar(workingDirectory[1])
      }
    }
  }

  return undefined
}

function workflowSteps(source) {
  const lines = source.split(/\r?\n/)
  const steps = []
  const workflowDefault = defaultRunWorkingDirectory(lines, 0, lines.length, 0)
  const workflowEnvironment = yamlEnvironment(lines, 0, lines.length, 0)

  for (let index = 0; index < lines.length; index += 1) {
    const stepsMatch = lines[index].match(/^(\s*)steps:\s*(?:#.*)?$/)
    if (!stepsMatch) continue

    const stepsIndent = stepsMatch[1].length
    const stepIndent = stepsIndent + 2
    const jobIndent = stepsIndent - 2
    let jobStart = -1
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const line = lines[previous]
      if (line.match(/^\s*/)[0].length === jobIndent && /^[\w.-]+:\s*(?:#.*)?$/.test(line.trim())) {
        jobStart = previous
        break
      }
    }
    let jobEnd = lines.length
    if (jobStart >= 0) {
      for (let next = jobStart + 1; next < lines.length; next += 1) {
        if (lines[next].trim() && lines[next].match(/^\s*/)[0].length <= jobIndent) {
          jobEnd = next
          break
        }
      }
    }
    const jobDefault =
      jobStart >= 0
        ? defaultRunWorkingDirectory(lines, jobStart + 1, jobEnd, jobIndent + 2)
        : undefined
    const jobEnvironment =
      jobStart >= 0 ? yamlEnvironment(lines, jobStart + 1, jobEnd, jobIndent + 2) : {}
    let block = []
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (line.trim() && line.match(/^\s*/)[0].length <= stepsIndent) break

      const indent = line.match(/^\s*/)[0].length
      if (line.trim() && indent === stepIndent && /^\s*-\s*/.test(line)) {
        if (block.length > 0) {
          steps.push({
            lines: block,
            jobId: jobStart,
            defaultWorkingDirectory: jobDefault ?? workflowDefault,
            environment: {
              ...workflowEnvironment,
              ...jobEnvironment,
              ...yamlEnvironment(block, 0, block.length, stepIndent + 2),
            },
          })
        }
        block = [line.replace(/^\s*-\s?/, '')]
      } else if (block.length > 0) {
        block.push(line)
      }
    }
    if (block.length > 0) {
      steps.push({
        lines: block,
        jobId: jobStart,
        defaultWorkingDirectory: jobDefault ?? workflowDefault,
        environment: {
          ...workflowEnvironment,
          ...jobEnvironment,
          ...yamlEnvironment(block, 0, block.length, stepIndent + 2),
        },
      })
    }
  }

  const resolvedSteps = steps.map(
    ({ lines: linesInStep, jobId, defaultWorkingDirectory, environment }) => {
      const stepSource = linesInStep.join('\n')
      const workingDirectory = stepSource.match(/^\s*working-directory:\s*(.*?)\s*$/m)?.[1]
      return {
        source: stepSource,
        shellSource: workflowRunSource(stepSource),
        jobId,
        workingDirectory: workingDirectory ? yamlScalar(workingDirectory) : defaultWorkingDirectory,
        environment,
      }
    },
  )

  return resolvedSteps.map((step, index) => ({
    ...step,
    writesComposeFileToGithubEnv: resolvedSteps
      .slice(0, index)
      .some(
        previous =>
          previous.jobId === step.jobId && writesComposeFileToGithubEnv(previous.shellSource),
      ),
  }))
}

function workflowRunSource(source) {
  const lines = source.split(/\r?\n/)
  const scripts = []

  for (let index = 0; index < lines.length; index += 1) {
    const run = lines[index].match(/^(\s*)run:\s*(.*?)\s*$/)
    if (!run) continue

    const runIndent = run[1].length
    const body = run[2]
    const scalarBody = yamlScalar(body)
    if (scalarBody && !/^[|>][+-]?$/.test(scalarBody)) {
      scripts.push(scalarBody)
      continue
    }

    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (line.trim() && line.match(/^\s*/)[0].length <= runIndent) break
      scripts.push(line.trim())
    }
  }

  return scripts.join('\n')
}

function shellComposeFileAssignments(source) {
  const assignments = []
  let unresolved = false
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    for (const segment of trimmed.split(/&&|\|\||[;|]/)) {
      const candidate = segment.trim()
      if (!/\bCOMPOSE_FILE\s*=/.test(candidate)) continue

      const match = candidate.match(
        /^(?:export\s+)?COMPOSE_FILE\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/,
      )
      if (match) assignments.push(match[1] ?? match[2] ?? match[3])
      else unresolved = true
    }
  }

  return { assignments, unresolved }
}

function writesComposeFileToGithubEnv(source) {
  return (
    /\bCOMPOSE_FILE\s*=/.test(source) &&
    /(?:>>?|tee\s+(?:-a\s+)?)\s*["']?(?:\$GITHUB_ENV\b|\$\{GITHUB_ENV\})/.test(source)
  )
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

function dotenvValue(value, file) {
  const trimmed = value.trim()
  if (trimmed.startsWith("'") || trimmed.startsWith('"')) {
    const quote = trimmed[0]
    const end = trimmed.indexOf(quote, 1)
    if (
      end < 0 ||
      (trimmed.slice(end + 1).trim() &&
        !trimmed
          .slice(end + 1)
          .trimStart()
          .startsWith('#'))
    ) {
      throw new Error(`Cannot statically resolve COMPOSE_FILE in ${file}`)
    }
    return trimmed.slice(1, end)
  }

  return trimmed.replace(/\s+#.*$/, '')
}

function dotenvComposeFile(source, file) {
  let composeFile
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?COMPOSE_FILE\s*=\s*(.*?)\s*$/)
    if (match) composeFile = dotenvValue(match[1], file)
  }
  return composeFile
}

function composeFilePaths(value, workingDirectory, pathSeparator, source, file) {
  if (pathSeparator !== undefined && pathSeparator !== ':' && pathSeparator !== '') {
    throw new Error(
      `Cannot statically resolve COMPOSE_FILE path separator "${pathSeparator}" in ${source}`,
    )
  }
  if (typeof value !== 'string' || !isLiteralComposeFileReference(value)) {
    throw new Error(`Cannot statically resolve COMPOSE_FILE "${value}" in ${source}`)
  }

  const references = value.split(':')
  if (references.some(reference => !reference.trim())) {
    throw new Error(`Cannot statically resolve COMPOSE_FILE "${value}" in ${source}`)
  }

  return references.map(reference => ({
    path: resolve(workingDirectory, reference.trim()),
    required: true,
    source: file,
  }))
}

async function readDotenvComposeFile(workingDirectory, source) {
  const dotenvPath = join(workingDirectory, '.env')
  try {
    const dotenv = await readFile(dotenvPath, 'utf8')
    return { value: dotenvComposeFile(dotenv, dotenvPath), path: dotenvPath }
  } catch (error) {
    if (error.code === 'ENOENT') return { value: undefined, path: dotenvPath }
    throw error
  }
}

export async function collectComposeFiles(root, sources, environment = process.env) {
  const references = new Map()

  for (const { path, source } of sources) {
    if (!hasDockerComposeCommand(source)) continue

    const isWorkflow = /[\\/]workflows[\\/][^\\/]+\.ya?ml$/.test(path)
    const commands = isWorkflow
      ? workflowSteps(source).filter(step => hasDockerComposeCommand(step.source))
      : [{ source, shellSource: source, workingDirectory: undefined }]

    for (const command of commands) {
      if (command.workingDirectory && !isLiteralComposeFileReference(command.workingDirectory)) {
        throw new Error(
          `Cannot statically resolve workflow working directory "${command.workingDirectory}" in ${path}`,
        )
      }
      const workingDirectory = resolve(root, command.workingDirectory || '.')
      const fileReferences = composeFileReferences(command.shellSource || command.source)
      if (command.writesComposeFileToGithubEnv && fileReferences.length === 0) {
        throw new Error(
          `Cannot statically resolve COMPOSE_FILE written to GITHUB_ENV before Compose step in ${path}`,
        )
      }
      if (fileReferences.length > 0) {
        for (const reference of fileReferences) {
          if (!isLiteralComposeFileReference(reference)) {
            throw new Error(
              `Cannot statically resolve explicit Compose file reference "${reference}" in ${path}`,
            )
          }
          references.set(resolve(workingDirectory, reference), { required: true, source: path })
        }
      } else {
        const commandEnvironment = command.environment || {}
        const shellComposeFile = shellComposeFileAssignments(command.shellSource || '')
        if (shellComposeFile.unresolved) {
          throw new Error(`Cannot statically resolve shell COMPOSE_FILE assignment in ${path}`)
        }
        const shellAssignments = shellComposeFile.assignments
        const hasWorkflowComposeFile = Object.hasOwn(commandEnvironment, 'COMPOSE_FILE')
        const hasRunnerComposeFile = Object.hasOwn(environment, 'COMPOSE_FILE')
        const hasComposeFile = hasWorkflowComposeFile || hasRunnerComposeFile
        const composeFile = hasWorkflowComposeFile
          ? commandEnvironment.COMPOSE_FILE
          : environment.COMPOSE_FILE
        const pathSeparator = Object.hasOwn(commandEnvironment, 'COMPOSE_PATH_SEPARATOR')
          ? commandEnvironment.COMPOSE_PATH_SEPARATOR
          : environment.COMPOSE_PATH_SEPARATOR

        if (shellAssignments.length > 0) {
          for (const shellComposeFile of shellAssignments) {
            for (const reference of composeFilePaths(
              shellComposeFile,
              workingDirectory,
              pathSeparator,
              path,
              path,
            )) {
              references.set(reference.path, reference)
            }
          }
        } else if (hasComposeFile && !composeFile) {
          throw new Error(`Cannot statically resolve COMPOSE_FILE in ${path}`)
        } else if (hasComposeFile) {
          for (const reference of composeFilePaths(
            composeFile,
            workingDirectory,
            pathSeparator,
            path,
            path,
          )) {
            references.set(reference.path, reference)
          }
        } else if (!hasComposeFile) {
          const dotenv = await readDotenvComposeFile(workingDirectory, path)
          if (dotenv.value) {
            for (const reference of composeFilePaths(
              dotenv.value,
              workingDirectory,
              pathSeparator,
              path,
              dotenv.path,
            )) {
              references.set(reference.path, reference)
            }
          } else {
            for (const defaultPath of defaultComposePaths(root, workingDirectory)) {
              if (!references.has(defaultPath)) {
                references.set(defaultPath, { required: false, source: path })
              }
            }
          }
        } else {
          for (const defaultPath of defaultComposePaths(root, workingDirectory)) {
            if (!references.has(defaultPath)) {
              references.set(defaultPath, { required: false, source: path })
            }
          }
        }
      }
    }
  }

  const found = []
  for (const [path, reference] of references) {
    try {
      found.push({ path, source: await readFile(path, 'utf8') })
    } catch (error) {
      if (error.code === 'ENOENT' && !reference.required) continue
      if (error.code === 'ENOENT') {
        throw new Error(
          `Explicit Compose file does not exist: ${path} (referenced by ${reference.source})`,
          { cause: error },
        )
      }
      throw error
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
  const helperSources = sources.filter(
    ({ path }) =>
      path !== fileURLToPath(import.meta.url) && /[\\/](?:actions|scripts)[\\/]/.test(path),
  )
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

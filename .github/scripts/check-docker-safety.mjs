import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const textExtensions = new Set(['.js', '.json', '.md', '.mjs', '.sh', '.ts', '.yml', '.yaml'])
const composeFileNames = [
  'compose.yaml',
  'compose.override.yaml',
  'compose.yml',
  'compose.override.yml',
  'docker-compose.yaml',
  'docker-compose.override.yaml',
  'docker-compose.yml',
  'docker-compose.override.yml',
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
const dockerManagementGroupOptionsWithValue = new Set([...dockerRootOptionsWithValue, '--builder'])
const dockerRootOptionsWithoutValue = new Set([
  '--debug',
  '--help',
  '--tls',
  '--tlsverify',
  '--version',
  '-D',
])

function shellTokens(source) {
  return [
    ...source.matchAll(/(?:\$'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s\\])+/g),
  ].map(match => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }))
}

function decodeAnsiCQuotedWord(token, sourcePosition = index => index) {
  const content = token.slice(2, -1)
  let value = ''
  const positions = [sourcePosition(2)]
  const simpleEscapes = {
    'a': '\x07',
    'b': '\b',
    'e': '\x1b',
    'E': '\x1b',
    'f': '\f',
    'n': '\n',
    'r': '\r',
    't': '\t',
    'v': '\v',
    '\\': '\\',
    "'": "'",
    '"': '"',
    '?': '?',
  }

  for (let index = 0; index < content.length;) {
    let decoded = content[index]
    let consumed = 1
    if (content[index] === '\\' && index + 1 < content.length) {
      const escape = content[index + 1]
      const numericEscape = content.slice(index + 2).match(/^[0-9a-f]{1,2}/i)
      const octalEscape = content.slice(index + 1).match(/^[0-7]{1,3}/)
      const unicodeEscape = content.slice(index + 2).match(/^(u[0-9a-f]{4}|U[0-9a-f]{8})/i)

      if (escape === 'x' && numericEscape) {
        decoded = String.fromCharCode(Number.parseInt(numericEscape[0], 16))
        consumed = numericEscape[0].length + 2
      } else if (unicodeEscape) {
        const digits = unicodeEscape[0].slice(1)
        const codePoint = Number.parseInt(digits, 16)
        decoded =
          digits.length === 4 || codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : unicodeEscape[0]
        consumed = unicodeEscape[0].length + 1
      } else if (octalEscape) {
        decoded = String.fromCharCode(Number.parseInt(octalEscape[0], 8))
        consumed = octalEscape[0].length + 1
      } else if (escape === 'c' && index + 2 < content.length) {
        const control = content[index + 2]
        decoded = String.fromCharCode(
          control === '?' ? 0x7f : control.toUpperCase().charCodeAt(0) & 0x1f,
        )
        consumed = 3
      } else {
        decoded = simpleEscapes[escape] ?? escape
        consumed = 2
      }
    }

    value += decoded
    const endPosition = sourcePosition(index + consumed + 2)
    for (let count = 0; count < decoded.length; count += 1) positions.push(endPosition)
    index += consumed
  }

  return { value, positions }
}

function splitShellControlOperators(token) {
  const fragments = []
  let fragmentStart = 0
  let quote

  for (let index = 0; index < token.value.length; index += 1) {
    const character = token.value[index]
    if (character === '\\' && quote !== "'") {
      index += 1
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character !== ';' && character !== '&' && character !== '|') continue

    if (index > fragmentStart) {
      fragments.push({
        value: token.value.slice(fragmentStart, index),
        start: token.start + fragmentStart,
        end: token.start + index,
      })
    }
    const operatorEnd = index + (token.value[index + 1] === character ? 2 : 1)
    fragments.push({
      value: token.value.slice(index, operatorEnd),
      start: token.start + index,
      end: token.start + operatorEnd,
    })
    fragmentStart = operatorEnd
    index = operatorEnd - 1
  }

  if (fragmentStart < token.value.length) {
    fragments.push({
      value: token.value.slice(fragmentStart),
      start: token.start + fragmentStart,
      end: token.end,
    })
  }

  return fragments
}

function isShellControlOperator(value) {
  return [';', '&', '&&', '|', '||'].includes(value)
}

function shellWords(source) {
  const words = []
  for (const token of shellTokens(source).flatMap(splitShellControlOperators)) {
    const previous = words.at(-1)
    if (
      previous?.end === token.start &&
      !isShellControlOperator(previous.value) &&
      !isShellControlOperator(token.value)
    ) {
      previous.value += token.value
      previous.end = token.end
    } else {
      words.push({ ...token })
    }
  }
  return words
}

function shellAssignmentEvents(source) {
  const assignmentBuiltins = new Set(['declare', 'export', 'local', 'readonly', 'typeset'])
  const events = []
  const pendingAssignments = []
  let commandName
  let previousEnd = 0
  let persistsAssignments = false

  const finishCommand = position => {
    if (commandName === undefined || persistsAssignments) {
      for (const assignment of pendingAssignments) events.push({ ...assignment, position })
    }
    pendingAssignments.length = 0
    commandName = undefined
    persistsAssignments = false
  }

  for (const word of shellWords(source)) {
    let lineBreak = -1
    for (let index = previousEnd; index < word.start; index += 1) {
      if (source[index] === '\n' || source[index] === '\r') {
        if (!isShellEscaped(source, index)) {
          lineBreak = index
          break
        }
        if (source[index] === '\r' && source[index + 1] === '\n') index += 1
      }
    }
    if (lineBreak !== -1) finishCommand(lineBreak)

    if (isShellControlOperator(word.value)) {
      finishCommand(word.end)
      previousEnd = word.end
      continue
    }

    const decoded = decodeShellWord(word.value).value
    const assignment = decoded.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (assignment && (commandName === undefined || persistsAssignments)) {
      pendingAssignments.push({ name: assignment[1], value: assignment[2] })
    } else if (commandName === undefined) {
      commandName = commandWord(decoded)
      persistsAssignments = assignmentBuiltins.has(commandName)
    }
    previousEnd = word.end
  }

  finishCommand(source.length)
  return events
}

function commandSubstitutionEnd(source, start) {
  let depth = 1
  let quote

  for (let index = start + 2; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\' && quote !== "'") {
      index += 1
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
    } else if (character === '`') {
      const end = source.indexOf('`', index + 1)
      if (end === -1) return -1
      index = end
    } else if (character === '(') {
      depth += 1
    } else if (character === ')' && --depth === 0) {
      return index
    }
  }

  return -1
}

function backtickSubstitutionEnd(source, start) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1
    } else if (source[index] === '`') {
      return index
    }
  }
  return -1
}

function shellSubstitutionRanges(source) {
  const ranges = []
  let quote

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\' && quote !== "'") {
      index += 1
      continue
    }
    if (quote === "'") {
      if (character === "'") quote = undefined
      continue
    }
    if (quote === '"' && character === '"') {
      quote = undefined
      continue
    }

    if (source.startsWith('$(', index)) {
      const end = commandSubstitutionEnd(source, index)
      if (end !== -1) {
        ranges.push({ start: index + 2, end })
        index = end
      }
    } else if (!quote && (source.startsWith('<(', index) || source.startsWith('>(', index))) {
      const end = commandSubstitutionEnd(source, index)
      if (end !== -1) {
        ranges.push({ start: index + 2, end })
        index = end
      }
    } else if (character === '`') {
      const end = backtickSubstitutionEnd(source, index)
      if (end !== -1) {
        ranges.push({ start: index + 1, end })
        index = end
      }
    } else if (!quote && (character === "'" || character === '"')) {
      quote = character
    }
  }

  return ranges
}

function shellCommandWords(source, offset = 0, sourcePositions) {
  const words = []
  const quotedRanges = []
  const sourcePosition = index => sourcePositions?.[index] ?? offset + index
  const context = { source }

  for (const word of shellWords(source)) {
    const decoded = decodeShellWord(word.value, index => sourcePosition(word.start + index))
    const assignment = decoded.value.match(/^[A-Za-z_][A-Za-z0-9_]*=/)
    const nestedValue = assignment ? decoded.value.slice(assignment[0].length) : decoded.value
    const nestedPositions = assignment
      ? decoded.positions.slice(assignment[0].length)
      : decoded.positions
    if (/\s/.test(nestedValue)) {
      quotedRanges.push({ start: word.start, end: word.end })
      words.push(...shellCommandWords(nestedValue, 0, nestedPositions))
    } else {
      words.push({
        ...word,
        value: decoded.value,
        start: sourcePosition(word.start),
        end: sourcePosition(word.end),
        context,
        contextStart: word.start,
        contextEnd: word.end,
      })
    }
  }

  for (const range of shellSubstitutionRanges(source)) {
    if (quotedRanges.some(quoted => range.start >= quoted.start && range.start < quoted.end)) {
      continue
    }
    const contentPositions = Array.from({ length: range.end - range.start + 1 }, (_, index) =>
      sourcePosition(range.start + index),
    )
    words.push(...shellCommandWords(source.slice(range.start, range.end), 0, contentPositions))
  }

  return words
}

function decodeShellWord(word, sourcePosition = index => index) {
  let value = ''
  const positions = [sourcePosition(0)]
  const append = (decoded, endPositions) => {
    value += decoded
    for (const position of endPositions) positions.push(position)
  }

  for (let index = 0; index < word.length;) {
    if (word.startsWith("$'", index)) {
      const quoted = word.slice(index).match(/^\$'(?:\\.|[^'\\])*'/)?.[0]
      if (quoted) {
        const decoded = decodeAnsiCQuotedWord(quoted, position => sourcePosition(index + position))
        append(decoded.value, decoded.positions.slice(1))
        index += quoted.length
        continue
      }
    }

    const character = word[index]
    if (character === "'" || character === '"') {
      const quote = character
      index += 1
      while (index < word.length && word[index] !== quote) {
        if (word[index] === '\\' && index + 1 < word.length) {
          append(word[index + 1], [sourcePosition(index + 2)])
          index += 2
        } else {
          append(word[index], [sourcePosition(index + 1)])
          index += 1
        }
      }
      if (word[index] === quote) index += 1
      if (positions.length === 1) positions[0] = sourcePosition(index)
      continue
    }

    if (character === '\\' && index + 1 < word.length) {
      append(word[index + 1], [sourcePosition(index + 2)])
      index += 2
      continue
    }

    append(character, [sourcePosition(index + 1)])
    index += 1
  }

  if (positions.length === 1) positions[0] = sourcePosition(word.length)
  return { value, positions }
}

function unquoteShellToken(token) {
  if (token.startsWith("$'") && token.endsWith("'")) {
    return decodeAnsiCQuotedWord(token).value
  }
  return (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
    ? token.slice(1, -1)
    : token
}

function rawCommandToken(token) {
  return token
    .replace(/['"]/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/^[($`]+|[);`]+$/g, '')
}

function commandWord(token) {
  return rawCommandToken(token).toLowerCase()
}

function managementSubcommandIndex(tokens, groupIndex) {
  for (let index = groupIndex + 1; index < tokens.length; index += 1) {
    const option = rawCommandToken(tokens[index].value)
    if (dockerManagementGroupOptionsWithValue.has(option)) {
      index += 1
      continue
    }
    if (!option.startsWith('-')) return index
  }
  return -1
}

// Docker resources whose subcommand follows the group word: `docker container run`.
const dockerManagementGroups = new Set([
  'builder',
  'container',
  'image',
  'network',
  'system',
  'volume',
])
const dockerManagementGroupAliases = new Map([['buildx', 'builder']])
const dockerContainerSubcommandAliases = new Map([
  ['list', 'ls'],
  ['remove', 'rm'],
])

function dockerInvocations(source) {
  const wordsByContext = new Map()
  for (const token of shellCommandWords(source).filter(
    token => !token.value.includes('$(') && !token.value.includes('`'),
  )) {
    const words = wordsByContext.get(token.context) ?? []
    words.push(token)
    wordsByContext.set(token.context, words)
  }

  const invocations = []

  for (const [context, words] of wordsByContext) {
    words.sort((left, right) => left.contextStart - right.contextStart)
    const assignmentEvents = shellAssignmentEvents(context.source)
    const assignments = new Map()
    let assignmentIndex = 0
    const matches = []

    for (const word of words) {
      while (assignmentEvents[assignmentIndex]?.position <= word.contextStart) {
        const { name, value } = assignmentEvents[assignmentIndex]
        if (/[$`]/.test(value)) assignments.delete(name)
        else assignments.set(name, value)
        assignmentIndex += 1
      }

      const variable = word.value.match(
        /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/,
      )
      const value = variable
        ? (assignments.get(variable[1] ?? variable[2]) ?? word.value)
        : word.value
      const command = commandWord(value)
      if (
        ['docker', 'docker-compose'].some(
          executable => command === executable || command.endsWith(`/${executable}`),
        )
      ) {
        matches.push({ ...word, command })
      }
    }

    for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
      const match = matches[matchIndex]
      const end = matches[matchIndex + 1]?.contextStart ?? context.source.length
      const afterDocker = match.contextEnd

      if (match.command.endsWith('/docker-compose') || match.command === 'docker-compose') {
        invocations.push({
          start: match.start,
          subcommand: 'compose',
          arguments: context.source.slice(afterDocker, end),
          command: context.source.slice(match.contextStart, end),
        })
        continue
      }

      const tokens = shellWords(context.source.slice(afterDocker, end))

      for (let index = 0; index < tokens.length; index += 1) {
        const token = commandWord(tokens[index].value)

        if (token === '-compose') {
          invocations.push({
            start: match.start,
            subcommand: 'compose',
            arguments: context.source.slice(afterDocker + tokens[index].end, end),
            command: context.source.slice(match.contextStart, end),
          })
          break
        }

        // Root options are case-sensitive (`-H` is not `-h`), so match them on the raw token.
        const option = rawCommandToken(tokens[index].value)

        if (dockerRootOptionsWithValue.has(option)) {
          if (!tokens[index + 1]) break
          index += 1
          continue
        }

        const attachedValueOption = [...dockerRootOptionsWithValue].some(
          rootOption =>
            option.startsWith(`${rootOption}=`) ||
            (rootOption.length === 2 &&
              rootOption.startsWith('-') &&
              option.startsWith(rootOption) &&
              option.length > 2),
        )
        if (
          attachedValueOption ||
          dockerRootOptionsWithoutValue.has(option) ||
          option.startsWith('-')
        ) {
          continue
        }

        let subcommandIndex = index
        let group
        const managementGroup = dockerManagementGroupAliases.get(token) ?? token
        if (dockerManagementGroups.has(managementGroup)) {
          subcommandIndex = managementSubcommandIndex(tokens, index)
          if (subcommandIndex === -1) break
          group = managementGroup
        }

        const parsedSubcommand = commandWord(tokens[subcommandIndex].value)
        const subcommand =
          group === 'container'
            ? (dockerContainerSubcommandAliases.get(parsedSubcommand) ?? parsedSubcommand)
            : parsedSubcommand
        invocations.push({
          start: match.start,
          group,
          subcommand,
          arguments: context.source.slice(afterDocker + tokens[subcommandIndex].end, end),
          command: context.source.slice(match.contextStart, end),
        })
        break
      }
    }
  }

  return invocations.sort((left, right) => left.start - right.start)
}

// Container commands: top-level (`docker rm`) or under the `container` group (`docker container rm`).
function isContainerCommand(invocation, subcommands) {
  return (
    subcommands.includes(invocation.subcommand) &&
    (invocation.group === undefined || invocation.group === 'container')
  )
}

// Short flags are read from grouped tokens; true assignments normalize to the flag name.
function dockerFlags(args) {
  const flags = new Set()
  for (const token of shellTokens(args)) {
    const word = rawCommandToken(token.value)
    if (word.startsWith('--')) {
      const [name, value] = word.split('=', 2)
      flags.add(value !== undefined && /^(?:1|t|true)$/i.test(value) ? name : word)
    } else if (/^-[A-Za-z]=(?:1|t|true)$/i.test(word)) {
      flags.add(word[1])
    } else if (/^-[A-Za-z]+$/.test(word)) {
      for (const letter of word.slice(1)) flags.add(letter)
    }
  }
  return flags
}

function removesEveryDockerContainer(invocations) {
  const removesContainers = invocations.some(invocation => isContainerCommand(invocation, ['rm']))
  const listsEveryContainer = invocations.some(invocation => {
    if (!isContainerCommand(invocation, ['ps', 'ls'])) return false
    const flags = dockerFlags(invocation.arguments)
    const emitsIdentifiers =
      flags.has('q') ||
      flags.has('--quiet') ||
      [...flags].some(flag => flag === '--format' || flag.startsWith('--format='))
    return (flags.has('a') || flags.has('--all')) && emitsIdentifiers
  })
  return removesContainers && listsEveryContainer
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

function hasUnsafeDockerPublish(invocation) {
  const isContainerPublish = isContainerCommand(invocation, ['run', 'create'])
  const isServiceCreate =
    invocation.group === undefined &&
    invocation.subcommand === 'service' &&
    /^\s*create(?:\s|$)/.test(invocation.arguments)
  if (!isContainerPublish && !isServiceCreate) return false

  const argumentsText = isServiceCreate
    ? invocation.arguments.replace(/^\s*create\b/, '')
    : invocation.arguments
  return dockerPublishValues(argumentsText).some(value => !isSafeDockerPublishValue(value))
}

function isSafeDockerPublishValue(value) {
  const forbiddenCharacters = ["'", '"', '$', '`', '{', '}', '\\']
  if (forbiddenCharacters.some(character => value.includes(character))) return false

  const port = String.raw`\d+(?:-\d+)?`
  const address = String.raw`(?:(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:]+\])`
  return new RegExp(`^(?:${port}|${address}::${port})(?:/(?:tcp|udp))?$`).test(value)
}

function dockerPublishValues(command) {
  const tokens = shellWords(command)
  const values = []

  for (let index = 0; index < tokens.length; index += 1) {
    const rawToken = tokens[index].value
    const token = rawToken.replace(/['"]/g, '').replace(/\\(.)/g, '$1')
    const optionName = token.split('=', 1)[0]
    if (optionName.startsWith('-') && /[$`{}]/.test(optionName)) {
      values.push(optionName)
      continue
    }
    if (token === '--publish' || token === '-p') {
      if (tokens[index + 1]) values.push(tokens[++index].value)
      continue
    }
    if (token.startsWith('--publish=')) {
      const separator = rawToken.indexOf('=')
      values.push(
        separator === -1 ? token.slice('--publish='.length) : rawToken.slice(separator + 1),
      )
      continue
    }

    const shortOption = token.match(/^-[A-Za-z]*p(?:=(.*)|(.*))$/)
    if (!shortOption) continue
    const attachedValue = shortOption[1] ?? shortOption[2]
    if (attachedValue) values.push(rawToken === token ? attachedValue : rawToken)
    else if (tokens[index + 1]) values.push(tokens[++index].value)
  }

  return values
}

function hasFixedHostPortWithVariableContainerPort(value) {
  if (
    /(?:(?:(?:\d{1,3}\.){3}\d{1,3}|localhost|\[[\da-f:]+\]):)?\d+(?:-\d+)?:\$(?:\{[^}]+\}|[A-Za-z_][\w]*|\d|[!#$?*@-])/.test(
      value,
    )
  ) {
    return true
  }

  const fixedHostPort = /(?:(?:(?:\d{1,3}\.){3}\d{1,3}|localhost|\[[\da-f:]+\]):)?\d+(?:-\d+)?:/g
  for (const match of value.matchAll(fixedHostPort)) {
    if (hasShellExpansionAt(value, match.index + match[0].length)) return true
  }
  return false
}

function hasFixedPortMapping(value) {
  const shortForm = value
    .split(/\r?\n/)
    .filter(line => !yamlMappingEntry(line))
    .join('\n')
  return (
    /(?:\d{1,3}(?:\.\d{1,3}){3}|localhost|\[[\da-f:]+\]):\d+(?:-\d+)?:\d+(?:-\d+)?|\d+(?:-\d+)?:\d+(?:-\d+)?/.test(
      shortForm,
    ) ||
    hasFixedHostPortWithVariableContainerPort(shortForm) ||
    hasVariableShortHostPort(shortForm)
  )
}

function hasVariableShortHostPort(value) {
  const variableHostPort = /(\$\{[^}]+\}|\$[A-Za-z_][\w]*|\$\d|\$[!#$?*@-]):/g
  for (const match of value.matchAll(variableHostPort)) {
    if (!isAlwaysEmptyComposeExpansion(match[1])) return true
  }
  return hasShellExpansionBeforeColon(value)
}

function hasShellExpansionBeforeColon(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (!isShellExpansionStart(value, index)) continue
    const end = shellExpansionEnd(value, index)
    if (end < 0 || value[end + 1] === ':') return true
    index = end
  }
  return false
}

function hasShellExpansionAt(value, index) {
  return isShellExpansionStart(value, index)
}

function isShellExpansionStart(value, index) {
  return (
    isBraceExpansionStart(value, index) ||
    value.startsWith('$(', index) ||
    value.startsWith('<(', index) ||
    value.startsWith('>(', index) ||
    value[index] === '`'
  )
}

function isBraceExpansionStart(value, index) {
  return (
    value[index] === '{' &&
    value[index - 1] !== '$' &&
    !isShellEscaped(value, index) &&
    braceExpansionEnd(value, index) >= 0
  )
}

function isShellEscaped(value, index) {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

function braceExpansionEnd(value, start) {
  let depth = 0
  let expandable = false
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += 1
      continue
    }
    if (value[index] === '{') {
      depth += 1
      continue
    }
    if (value[index] === '}') {
      depth -= 1
      if (depth === 0) return expandable ? index : -1
      continue
    }
    if (depth === 1 && (value[index] === ',' || value.startsWith('..', index))) {
      expandable = true
    }
  }
  return -1
}

function shellExpansionEnd(value, start) {
  if (value[start] === '`') {
    for (let index = start + 1; index < value.length; index += 1) {
      if (value[index] === '\\') {
        index += 1
      } else if (value[index] === '`') {
        return index
      }
    }
    return -1
  }
  if (value[start] === '{') return braceExpansionEnd(value, start)

  let depth = 1
  let quote = null
  for (let index = start + 2; index < value.length; index += 1) {
    const character = value[index]
    if (character === '\\' && quote !== "'") {
      index += 1
      continue
    }
    if (quote === "'") {
      if (character === "'") quote = null
      continue
    }
    if (quote === '"' && character === '"') {
      quote = null
      continue
    }
    if (quote === null && (character === "'" || character === '"')) {
      quote = character
      continue
    }
    if (quote !== "'" && isShellExpansionStart(value, index)) {
      const nestedEnd = shellExpansionEnd(value, index)
      if (nestedEnd < 0) return -1
      index = nestedEnd
      continue
    }
    if (character === '(') depth += 1
    if (character === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function isAlwaysEmptyComposeExpansion(value) {
  return /^\$\{[A-Za-z_][\w]*(?::\+|\+)\}$/.test(value)
}

function isFixedPublishedPort(value) {
  const scalar = yamlScalar(value).trim()
  if (/^\d+(?:-\d+)?$/.test(scalar)) return true
  return /\$\{[^}]+\}|\$[A-Za-z_][\w]*/.test(scalar) && !isAlwaysEmptyComposeExpansion(scalar)
}

function hasFixedPublishedPort(value) {
  for (const line of value.split(/\r?\n/)) {
    const mapping = yamlMappingEntry(line)
    const inlineMappingValue = yamlInlineMappingValue(line, 'published')
    if (mapping?.key === 'published' && isFixedPublishedPort(mapping.value)) return true

    const inlineMapping = inlineMappingValue?.match(/^(?:"([^"]*)"|'([^']*)'|([^,}\]]+))/)
    const inlineValue = inlineMapping?.[1] ?? inlineMapping?.[2] ?? inlineMapping?.[3]
    if (inlineValue && isFixedPublishedPort(inlineValue)) return true
  }
  return false
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

function shellScriptRegions(source, file) {
  if (!/\.ya?ml$/i.test(file)) return [{ source, line: 1 }]

  const lines = source.split(/\r?\n/)
  const regions = []

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/)
    if (!match) continue

    const line = index + 1
    const scalar = match[2].trim()
    if (!/^[|>](?:[+-][1-9]?|[1-9][+-]?)?(?:\s+#.*)?$/.test(scalar)) {
      regions.push({ source: match[2], line })
      continue
    }

    const mappingIndent = match[1].length
    const scriptLines = []
    let contentIndent
    let next = index + 1
    for (; next < lines.length; next += 1) {
      const scriptLine = lines[next]
      if (!scriptLine.trim()) {
        scriptLines.push(scriptLine)
        continue
      }

      const indent = scriptLine.match(/^\s*/)[0].length
      if (indent <= mappingIndent || (contentIndent !== undefined && indent < contentIndent)) {
        break
      }
      contentIndent ??= indent
      scriptLines.push(scriptLine)
    }
    regions.push({ source: scriptLines.join('\n'), line: line + 1 })
    index = next - 1
  }

  return regions.length > 0 ? regions : [{ source, line: 1 }]
}

export function findDockerSafetyViolations(source, file = '<input>') {
  const lines = source.split(/\r?\n/)
  const violations = []
  const isWorkflow = /[\\/]workflows[\\/][^\\/]+\.ya?ml$/.test(file)
  if (isWorkflow) assertNoYamlAnchorsOrAliases(source, file)
  const matrixContext = isWorkflow ? workflowMatrixContext(source) : undefined

  for (const script of shellScriptRegions(source, file)) {
    const invocations = dockerInvocations(script.source)

    for (const invocation of invocations) {
      const line =
        script.line + (script.source.slice(0, invocation.start).match(/\n/g) ?? []).length

      if (isContainerCommand(invocation, ['create', 'run'])) {
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
            line,
            message: 'container name is not unique to this job',
          })
        }
      }

      if (hasUnsafeDockerPublish(invocation)) {
        violations.push({ file, line, message: 'fixed host-port publishing' })
      }

      if (dockerManagementGroups.has(invocation.group) && invocation.subcommand === 'prune') {
        if (invocation.group === 'system') {
          violations.push({
            file,
            line,
            message: 'Docker system prune is not allowed',
          })
        } else if (!hasJobLabelFilter(invocation.arguments, matrixContext)) {
          violations.push({ file, line, message: 'unfiltered Docker prune' })
        }
      }
    }

    if (!removesEveryDockerContainer(invocations)) continue

    const removal = invocations.find(invocation => isContainerCommand(invocation, ['rm']))
    const line = script.line + (script.source.slice(0, removal.start).match(/\n/g) ?? []).length
    violations.push({ file, line, message: 'removing every Docker container' })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const mapping = yamlMappingEntry(lines[index])
    const inlinePorts = yamlInlineMappingValue(lines[index], 'ports')
    if (mapping?.key !== 'ports' && inlinePorts === undefined) continue

    const indent = mapping?.key === 'ports' ? mapping.indent : lines[index].match(/^\s*/)[0].length
    let block = mapping?.key === 'ports' ? mapping.value : inlinePorts
    for (let next = index + 1; next < lines.length; next += 1) {
      if (!lines[next].trim()) continue
      const nextIndent = lines[next].match(/^\s*/)[0].length
      if (nextIndent <= indent) break
      block += `\n${lines[next]}`
    }

    if (hasFixedPortMapping(block) || hasFixedPublishedPort(block)) {
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

function dockerComposeCommandCount(source) {
  return dockerInvocations(normalizeShellContinuations(source)).filter(
    invocation => invocation.subcommand === 'compose',
  ).length
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

function composeCommandInvocations(source) {
  const invocations = []
  for (const segment of shellCommandSegments(source)) {
    for (const command of dockerInvocations(segment)) {
      if (command.subcommand === 'compose') invocations.push({ command, segment })
    }
  }
  return invocations
}

function composeFileReferences(commandArguments, source) {
  const references = []
  const tokens = shellTokens(commandArguments)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = unquoteShellToken(tokens[index].value)
    const word = commandWord(tokens[index].value)
    if (composeSubcommands.has(word)) break

    let reference

    if (token === '-f' || token === '--file') {
      if (!tokens[index + 1]) {
        throw new Error(`Cannot statically resolve explicit Compose file option in ${source}`)
      }
      reference = unquoteShellToken(tokens[++index].value)
    } else if (token.startsWith('--file=')) {
      reference = token.slice('--file='.length)
    } else if (token.startsWith('--file')) {
      throw new Error(
        `Cannot statically resolve explicit Compose file option "${token}" in ${source}`,
      )
    } else if (token.startsWith('-f') && token.length > 2) {
      reference = token.slice(2).replace(/^=/, '')
    } else if (composeGlobalOptionsWithValue.has(token)) {
      if (!tokens[index + 1]) {
        throw new Error(`Cannot statically resolve Compose option "${token}" in ${source}`)
      }
      index += 1
    } else if (token.startsWith('-')) {
      continue
    } else {
      continue
    }

    if (reference !== undefined) {
      if (!reference) {
        throw new Error(`Cannot statically resolve explicit Compose file option in ${source}`)
      }
      references.push(reference)
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

function yamlMappingEntry(line) {
  const match = line.match(
    /^(\s*)(?:-\s*)?(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w-]*))\s*:(?=\s|$|[\[{])\s*(.*)$/,
  )
  if (!match) return undefined
  return {
    indent: match[1].length,
    key: match[2] ?? match[3] ?? match[4],
    value: match[5],
  }
}

function yamlInlineMappingValue(line, key) {
  const keyPattern = `(?:"${key}"|'${key}'|${key})`
  const match = line.match(new RegExp(`(?:^|[{,])\\s*${keyPattern}\\s*:\\s*(.*)$`))
  return match?.[1]
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
    let stepIndent
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (!line.trim() || line.trimStart().startsWith('#')) continue

      const indent = line.match(/^\s*/)[0].length
      if (indent < stepsIndent || (indent === stepsIndent && !/^\s*-\s*/.test(line))) break
      if (/^\s*-\s*/.test(line)) {
        stepIndent = indent
        break
      }
    }
    if (stepIndent === undefined) continue

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
      const indent = line.match(/^\s*/)[0].length
      const itemAtStepsIndent =
        stepIndent === stepsIndent && indent === stepsIndent && /^\s*-\s*/.test(line)
      if (line.trim() && (indent < stepsIndent || (indent === stepsIndent && !itemAtStepsIndent))) {
        break
      }

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

function assertNoYamlAnchorsOrAliases(source, file) {
  if (hasYamlAnchorsOrAliases(source)) {
    throw new Error(`Cannot statically scan YAML anchors or aliases in ${file}`)
  }
}

function assertComposeFileScannable(source, file) {
  assertNoYamlAnchorsOrAliases(source, file)

  let extendsIndent = -1

  for (const line of source.split(/\r?\n/)) {
    const content = yamlScalar(line)
    if (!content) continue

    const indent = line.match(/^\s*/)[0].length
    if (extendsIndent >= 0 && indent <= extendsIndent) extendsIndent = -1

    const mapping = yamlMappingEntry(line)
    if (mapping?.key === 'include' || yamlInlineMappingValue(line, 'include') !== undefined) {
      throw new Error(`Cannot statically scan Compose include or extends.file in ${file}`)
    }

    const inlineExtends = yamlInlineMappingValue(line, 'extends')
    if (inlineExtends !== undefined && mapping?.key !== 'extends') {
      throw new Error(`Cannot statically scan Compose include or extends.file in ${file}`)
    }

    if (mapping?.key !== 'extends') {
      if (
        extendsIndent >= 0 &&
        indent > extendsIndent &&
        (mapping?.key === 'file' || /(?:^|\s)[*&][\w-]+/.test(content))
      ) {
        throw new Error(`Cannot statically scan Compose include or extends.file in ${file}`)
      }
      continue
    }

    extendsIndent = mapping.indent
    if (
      /^(?:\{|\[)/.test(mapping.value) ||
      /(?:^|[{,])\s*(?:"file"|'file'|file)\s*:/i.test(mapping.value) ||
      /(?:^|\s)[*&][\w-]+/.test(mapping.value)
    ) {
      throw new Error(`Cannot statically scan Compose include or extends.file in ${file}`)
    }
  }
}

function hasYamlAnchorsOrAliases(source) {
  let blockScalarIndent

  for (const line of source.split(/\r?\n/)) {
    const indent = line.match(/^\s*/)[0].length
    if (blockScalarIndent !== undefined) {
      if (!line.trim() || indent > blockScalarIndent) continue
      blockScalarIndent = undefined
    }

    const content = yamlScalar(line)
    if (!content || content.trimStart().startsWith('#')) continue

    const mapping = yamlMappingEntry(line)
    const blockIndicator = mapping?.value ?? content.trim().replace(/^-\s*/, '')
    if (/^[|>][+-]?\d?[+-]?(?:\s+#.*)?$/.test(blockIndicator)) {
      blockScalarIndent = mapping?.indent ?? indent
      continue
    }

    if (/(?:^|[:,\[{]\s*|-\s*)[&*][^\s,\]}]+/.test(content)) return true
  }

  return false
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
    let commands
    if (isWorkflow) {
      const steps = workflowSteps(source)
      const parsedComposeCommandCount = steps.reduce(
        (count, step) => count + dockerComposeCommandCount(step.source),
        0,
      )
      if (dockerComposeCommandCount(source) !== parsedComposeCommandCount) {
        throw new Error(
          `Cannot parse Docker Compose command in an unparsed workflow step in ${path}`,
        )
      }
      commands = steps.filter(step => hasDockerComposeCommand(step.source))
    } else {
      commands = [{ source, shellSource: source, workingDirectory: undefined }]
    }

    for (const command of commands) {
      if (command.workingDirectory && !isLiteralComposeFileReference(command.workingDirectory)) {
        throw new Error(
          `Cannot statically resolve workflow working directory "${command.workingDirectory}" in ${path}`,
        )
      }
      const workingDirectory = resolve(root, command.workingDirectory || '.')
      const invocationSelections = composeCommandInvocations(
        command.shellSource || command.source,
      ).map(({ command: invocation, segment }) => ({
        references: composeFileReferences(invocation.arguments, segment),
      }))
      if (
        command.writesComposeFileToGithubEnv &&
        invocationSelections.some(selection => selection.references.length === 0)
      ) {
        throw new Error(
          `Cannot statically resolve COMPOSE_FILE written to GITHUB_ENV before Compose step in ${path}`,
        )
      }
      for (const selection of invocationSelections) {
        for (const reference of selection.references) {
          if (!isLiteralComposeFileReference(reference)) {
            throw new Error(
              `Cannot statically resolve explicit Compose file reference "${reference}" in ${path}`,
            )
          }
          references.set(resolve(workingDirectory, reference), { required: true, source: path })
        }
      }
      if (invocationSelections.some(selection => selection.references.length === 0)) {
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
      const source = await readFile(path, 'utf8')
      assertComposeFileScannable(source, path)
      found.push({ path, source })
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
  const workflowFiles = await listTextFiles(join(root, '.github', 'workflows'))
  if (!workflowFiles.some(path => /\.ya?ml$/i.test(path))) {
    throw new Error(`No workflow files found in ${join(root, '.github', 'workflows')}`)
  }
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
  if (scanned.size === 0) throw new Error('No Docker workflow or helper files were scanned')
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

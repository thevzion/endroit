import { resolve } from 'node:path'

export const CREATE_WORDMARK = 'endroit'

const modes = [
  {
    value: 'solo',
    label: 'Solo',
    hint: 'Home and personal Desk share Git; Site Routes stay local',
  },
  {
    value: 'team',
    label: 'Team',
    hint: 'the Home is shared; each collaborator keeps a private Desk',
  },
]

const equipment = [
  { value: 'research', label: 'Research', hint: 'reusable evidence-backed studies' },
  { value: 'planning', label: 'Planning', hint: 'roadmaps and bounded initiatives' },
  { value: 'publishing', label: 'Publishing', hint: 'source-owned publications and external Handles' },
  { value: 'scratch', label: 'Scratch', hint: 'retained exploratory work' },
]

export async function runCreateWizard(options) {
  const restoreColorEnvironment = disableColorWhenRequested()
  try {
    return await renderWizard(options)
  } finally {
    restoreColorEnvironment()
  }
}

async function renderWizard(options) {
  const prompts = options.prompts ?? await import('@clack/prompts')
  const common = { input: options.io.stdin, output: options.io.stdout }
  const stop = (value) => {
    if (!prompts.isCancel(value)) return false
    prompts.cancel('Creation cancelled. No files were written.', common)
    return true
  }

  prompts.intro(`${CREATE_WORDMARK}\n\nOwn the place where your agents work.`, common)
  prompts.note([
    'A Home owns shared rules and Rooms.',
    'Your Desk keeps personal continuity.',
    'Sites keep their repositories and history.',
  ].join('\n'), 'What Endroit owns', common)

  let mode = options.mode
  if (!mode) {
    mode = await prompts.select({
      ...common,
      message: 'How will this Home be used?',
      options: modes,
      initialValue: 'solo',
    })
    if (stop(mode)) return cancelled()
  }

  let selected = options.selected
  if (!options.selectionProvided) {
    selected = await prompts.multiselect({
      ...common,
      message: 'Add optional Equipment',
      options: equipment,
      initialValues: [],
      required: false,
    })
    if (stop(selected)) return cancelled()
  }

  selected ??= []
  prompts.note([
    `Home        ${resolve(options.destination)}`,
    `Mode        ${mode}`,
    `Providers   ${options.providers.join(', ')}`,
    `Foundation  ${options.foundation.join(', ')}`,
    `Optional    ${selected.length ? selected.join(', ') : 'None'}`,
  ].join('\n'), 'Ready to create', common)

  if (!options.yes) {
    const accepted = await prompts.confirm({
      ...common,
      message: 'Create this Home?',
      active: 'Create',
      inactive: 'Cancel',
      initialValue: true,
    })
    if (stop(accepted)) return cancelled()
    if (!accepted) {
      prompts.cancel('Creation cancelled. No files were written.', common)
      return cancelled()
    }
  }

  const progress = prompts.spinner({ output: options.io.stdout })
  progress.start('Creating and validating the Home')
  let result
  try {
    result = await options.create({ mode, selected })
    progress.stop('Home created and verified')
  } catch (error) {
    progress.error('Home creation failed')
    throw error
  }

  prompts.note([
    ...result.launch.flatMap((entry) => [
      `${capitalize(entry.provider)}  ${entry.command}`,
      `        Then invoke ${entry.onboarding}.`,
    ]),
    '',
    'Tell your agent what you are working on.',
  ].join('\n'), 'Open your Home', common)
  prompts.outro(`Ready at ${result.home}`, common)
  return { rendered: true, exitCode: 0, result }
}

function disableColorWhenRequested() {
  if (!Object.hasOwn(process.env, 'NO_COLOR')) return () => {}
  const noColor = process.env.NO_COLOR
  const hadForceColor = Object.hasOwn(process.env, 'FORCE_COLOR')
  const forceColor = process.env.FORCE_COLOR
  delete process.env.NO_COLOR
  process.env.FORCE_COLOR = '0'
  return () => {
    process.env.NO_COLOR = noColor
    if (hadForceColor) process.env.FORCE_COLOR = forceColor
    else delete process.env.FORCE_COLOR
  }
}

function cancelled() {
  return { rendered: true, exitCode: 0, cancelled: true }
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`
}

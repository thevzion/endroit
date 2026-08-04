import { resolve } from 'node:path'

export const CREATE_WORDMARK = 'endroit'

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
    'A Workplace owns its declaration and shared Rooms.',
    'Your Desk keeps personal continuity.',
    'Sites keep their repositories and history.',
  ].join('\n'), 'What Endroit owns', common)

  const selected = options.selected ?? []
  prompts.note([
    `Workplace   ${resolve(options.destination)}`,
    `Desk        ${options.desk}`,
    `Providers   ${options.providers.join(', ')}`,
    `Foundation  ${options.foundation.join(', ')}`,
    `Optional    ${selected.length ? selected.join(', ') : 'None'}`,
  ].join('\n'), 'Ready to create', common)

  if (!options.yes) {
    const accepted = await prompts.confirm({
      ...common,
      message: 'Create this Workplace?',
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
  progress.start('Creating and validating the Workplace')
  let result
  try {
    result = await options.create({ selected })
    progress.stop('Workplace created and verified')
  } catch (error) {
    progress.error('Workplace creation failed')
    throw error
  }

  prompts.note([
    ...result.launch.flatMap((entry) => [
      `${capitalize(entry.provider)}  ${entry.command}`,
      '        Then describe what you are working on in normal language.',
      `        Optional onboarding shortcut: ${entry.onboarding}.`,
    ]),
  ].join('\n'), 'Open your Workplace', common)
  prompts.outro(`Ready at ${result.workplace}`, common)
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

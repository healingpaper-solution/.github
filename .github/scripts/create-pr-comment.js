const appFn = require('./index.js')
const { createProbot } = require('probot')
const Settings = require('./lib/settings')
const ConfigManager = require('./lib/configManager')
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const env = require('./lib/env')

async function syncWithPRComment() {
  try {
    // Read PR event data from GitHub Actions
    const eventPath = process.env.GITHUB_EVENT_PATH
    if (!eventPath) {
      throw new Error('GITHUB_EVENT_PATH environment variable not found')
    }

    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'))

    if (!event.pull_request) {
      throw new Error('No pull request found in event payload')
    }

    // Initialize Probot
    const probot = createProbot()

    // Get installation ID from organization
    probot.log.info('Fetching installations...')
    const authGithub = await probot.auth()
    const installations = await authGithub.paginate(
      authGithub.apps.listInstallations.endpoint.merge({ per_page: 100 })
    )

    if (installations.length === 0) {
      throw new Error('No installations found')
    }

    const installation = installations[0]
    probot.log.info(`Found installation: ${installation.id}`)

    // Authenticate as the installation
    const github = await probot.auth(installation.id)

    // Construct repository object
    const repo = {
      repo: process.env.ADMIN_REPO || '.github',
      owner: installation.account.login
    }

    // Construct synthetic context with fake check_run structure
    // This mimics the webhook event structure that handleResults expects
    const context = {
      payload: {
        installation,
        repository: {
          owner: { login: event.repository.owner.login },
          name: event.repository.name
        },
        // This is the critical part - handleResults looks for this structure
        check_run: {
          id: 0, // Dummy ID - handleResults will try to update check run, but we'll ignore errors
          check_suite: {
            pull_requests: [{
              number: event.pull_request.number
            }]
          }
        }
      },
      octokit: github,
      log: probot.log,
      repo: () => repo
    }

    probot.log.info(`Starting sync for PR #${event.pull_request.number} in NOP mode`)

    // Load deployment config (same logic as syncAllSettings)
    let deploymentConfig = {}
    if (env.DEPLOYMENT_CONFIG_FILE && fs.existsSync(env.DEPLOYMENT_CONFIG_FILE)) {
      deploymentConfig = yaml.load(fs.readFileSync(env.DEPLOYMENT_CONFIG_FILE, 'utf8'))
    }

    // Load global settings using ConfigManager
    // ConfigManager expects (context, ref) - context needs to have repo() function
    const configManager = new ConfigManager(context, event.pull_request.head.ref)
    const repoSettings = await configManager.loadGlobalSettingsYaml()

    // Merge configs
    const runtimeConfig = { restrictedRepos: ['admin', '.github', 'safe-settings'], ...repoSettings }
    const config = { ...runtimeConfig, ...deploymentConfig }

    // Create Settings instance and call methods individually
    // This gives us more control to avoid double-calling handleResults
    const settings = new Settings(true, context, repo, config, event.pull_request.head.ref)

    let commentPosted = false
    try {
      await settings.loadConfigs()
      await settings.updateOrg()
      await settings.updateAll()

      // Call handleResults once to post PR comment
      // Wrap in try-catch to handle check run update error
      try {
        await settings.handleResults()
        commentPosted = true
        probot.log.info('PR comment posted successfully')
      } catch (handleError) {
        const isCheckRunError =
          (handleError.request && handleError.request.url && handleError.request.url.includes('check-runs')) ||
          (handleError.message && handleError.message.includes('check-runs')) ||
          (handleError.status === 404 && handleError.request && handleError.request.method === 'PATCH')

        if (isCheckRunError) {
          commentPosted = true
          probot.log.info('PR comment posted successfully (check run update failed as expected)')
        } else {
          throw handleError
        }
      }
    } catch (error) {
      settings.logError(error.message)

      // Only call handleResults if we haven't posted the comment yet
      if (!commentPosted) {
        try {
          await settings.handleResults()
          probot.log.info('PR comment posted after error')
        } catch (handleError) {
          // Ignore check run errors here too
          const isCheckRunError =
            (handleError.request && handleError.request.url && handleError.request.url.includes('check-runs')) ||
            (handleError.status === 404 && handleError.request && handleError.request.method === 'PATCH')

          if (!isCheckRunError) {
            throw handleError
          }
        }
      }
    }
  } catch (error) {
    console.error('Error during sync:', error)
    process.exit(1)
  }
}

syncWithPRComment()

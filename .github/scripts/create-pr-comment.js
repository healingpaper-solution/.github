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

    // Call Settings.syncAll directly with NOP mode = true
    // This will automatically call handleResults which will post the PR comment
    try {
      await Settings.syncAll(true, context, repo, config, event.pull_request.head.ref)
      probot.log.info('Sync completed successfully')
    } catch (syncError) {
      // Check if the error is about check run update (expected since we don't have a real check run)
      const isCheckRunError =
        (syncError.request && syncError.request.url && syncError.request.url.includes('check-runs')) ||
        (syncError.message && syncError.message.includes('check-runs')) ||
        (syncError.status === 404 && syncError.request && syncError.request.method === 'PATCH')

      if (isCheckRunError) {
        probot.log.info('PR comment posted successfully (check run update failed as expected)')
        // Exit successfully since the PR comment was posted
      } else {
        // Re-throw other errors
        throw syncError
      }
    }
  } catch (error) {
    console.error('Error during sync:', error)
    process.exit(1)
  }
}

syncWithPRComment()

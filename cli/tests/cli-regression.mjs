import assert from 'node:assert/strict';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const completionSupportPath = path.join(repoRoot, 'dist', 'cli', 'completionSupport.js');
const cloudParsersPath = path.join(repoRoot, 'dist', 'commands', 'cloudParsers.js');
const nonCloudParsersPath = path.join(repoRoot, 'dist', 'commands', 'nonCloudParsers.js');
const { main } = await import(pathToFileURL(cliPath).href);
const { createCompletionSupport } = await import(pathToFileURL(completionSupportPath).href);
const { createCloudParsers } = await import(pathToFileURL(cloudParsersPath).href);
const { createNonCloudParsers } = await import(pathToFileURL(nonCloudParsersPath).href);
const INTERNAL_COMPLETION_INSTALL_ENV = 'DEVBOX_INTERNAL_COMPLETION_INSTALL';

function createParserHarness() {
  class RuntimeError extends Error {
    constructor(message) {
      super(message);
      this.name = 'RuntimeError';
    }
  }

  const noop = () => {};
  const sentinels = {
    cmdCompletionInstall: noop,
    cmdDevboxProvision: noop,
    cmdDevboxStatus: noop,
    cmdDevboxStart: noop,
    cmdDevboxStop: noop,
    cmdDevboxTerminate: noop,
    cmdDevboxSsh: noop,
    cmdDevboxSshConfig: noop,
    cmdDevboxUnsafeCopyGitKey: noop,
    cmdDebug: noop,
    cmdDockerPull: noop,
    cmdDockerUpdate: noop,
    cmdDevcontainerGenerate: noop,
    cmdArtifactsUpload: noop,
    cmdArtifactsDownload: noop,
    cmdArtifactsList: noop,
  };

  const completionSupport = createCompletionSupport({
    CLI_NAME: 'devbox',
    CACHE_NAMESPACE: 'devbox',
    INTERNAL_COMPLETION_INSTALL_ENV,
    RuntimeError,
    splitLines: (text) => String(text ?? '').split(/\r?\n/),
    getShellRcPath: () => path.join(repoRoot, '.tmp-shellrc'),
    upsertShellBlock: () => false,
  });

  const cloudParsers = createCloudParsers({
    parseOptions: completionSupport.parseOptions,
    RuntimeError,
    cmdDevboxProvision: sentinels.cmdDevboxProvision,
    cmdDevboxStatus: sentinels.cmdDevboxStatus,
    cmdDevboxStart: sentinels.cmdDevboxStart,
    cmdDevboxStop: sentinels.cmdDevboxStop,
    cmdDevboxTerminate: sentinels.cmdDevboxTerminate,
    cmdDevboxSsh: sentinels.cmdDevboxSsh,
    cmdDevboxSshConfig: sentinels.cmdDevboxSshConfig,
    cmdDevboxUnsafeCopyGitKey: sentinels.cmdDevboxUnsafeCopyGitKey,
    cmdDebug: sentinels.cmdDebug,
  });

  const nonCloudParsers = createNonCloudParsers({
    parseOptions: completionSupport.parseOptions,
    RuntimeError,
    cmdDockerPull: sentinels.cmdDockerPull,
    cmdDockerUpdate: sentinels.cmdDockerUpdate,
    cmdDevcontainerGenerate: sentinels.cmdDevcontainerGenerate,
    cmdArtifactsUpload: sentinels.cmdArtifactsUpload,
    cmdArtifactsDownload: sentinels.cmdArtifactsDownload,
    cmdArtifactsList: sentinels.cmdArtifactsList,
  });

  return {
    sentinels,
    RuntimeError,
    ...completionSupport,
    ...cloudParsers,
    ...nonCloudParsers,
  };
}

const parserHarness = createParserHarness();

async function runCli(args) {
  const stdout = [];
  const stderr = [];
  let status = 0;

  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;

  console.log = (...items) => {
    stdout.push(util.format(...items));
  };
  console.error = (...items) => {
    stderr.push(util.format(...items));
  };
  process.exit = ((code = 0) => {
    const err = new Error('__TEST_EXIT__');
    err.name = 'TestExit';
    err.code = Number(code);
    throw err;
  });

  try {
    await main(args);
  } catch (error) {
    if (error && error.name === 'TestExit') {
      status = Number(error.code ?? 0);
    } else if (error && error.name === 'RuntimeError') {
      stdout.push(`Error: ${error.message}`);
      status = 1;
    } else if (error && error.name === 'MissingCommandError') {
      stdout.push(`Error: command not found: ${error.filename}`);
      status = 1;
    } else if (error && error.name === 'CommandError') {
      stdout.push(`Command failed: ${Array.isArray(error.cmd) ? error.cmd.join(' ') : ''}`.trim());
      if (error.stdout) {
        stdout.push(String(error.stdout).replace(/\n$/, ''));
      }
      if (error.stderr) {
        stdout.push(String(error.stderr).replace(/\n$/, ''));
      }
      status = Number(error.returncode ?? 1);
    } else {
      throw error;
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }

  return {
    status,
    stdout: stdout.join('\n') + (stdout.length ? '\n' : ''),
    stderr: stderr.join('\n') + (stderr.length ? '\n' : ''),
    output:
      (stdout.join('\n') + (stdout.length ? '\n' : '')) +
      (stderr.join('\n') + (stderr.length ? '\n' : '')),
  };
}

const cases = [
  {
    name: 'help prints usage and docker update example',
    run: async () => {
      const r = await runCli(['--help']);
      assert.equal(r.status, 0);
      assert.match(r.output, /Usage: devbox/);
      assert.match(r.output, /docker update --tag amd64-latest/);
    },
  },
  {
    name: 'docker update requires --tag',
    run: async () => {
      const r = await runCli(['docker', 'update']);
      assert.equal(r.status, 1);
      assert.match(r.output, /requires --tag/);
    },
  },
  {
    name: 'docker update rejects empty --tag',
    run: async () => {
      const r = await runCli(['docker', 'update', '--tag=']);
      assert.equal(r.status, 1);
      assert.match(r.output, /non-empty value: --tag/);
    },
  },
  {
    name: 'docker pull unknown option fails during parsing',
    run: async () => {
      const r = await runCli(['docker', 'pull', '--not-a-real-option']);
      assert.equal(r.status, 1);
      assert.match(r.output, /Unknown option: --not-a-real-option/);
    },
  },
  {
    name: 'completion suggests docker update --tag option',
    run: async () => {
      const r = await runCli(['__complete', 'docker', 'update', '--t']);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /--tag/);
    },
  },
  {
    name: 'completion suggests docker tag values',
    run: async () => {
      const r = await runCli(['__complete', 'docker', 'update', '--tag', 'a']);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /amd64-latest/);
    },
  },
  {
    name: 'unknown cloud subcommand fails during parsing',
    run: async () => {
      const r = await runCli(['cloud', 'definitely-nope']);
      assert.equal(r.status, 1);
      assert.match(r.output, /Unknown cloud command: definitely-nope/);
    },
  },
  {
    name: 'cloud init parser accepts WSL flags',
    run: async () => {
      const args = {};
      parserHarness.parseCloud(
        ['init', '--wsl', '--windows-user', 'pikag', '--wsl-distro', 'Ubuntu', '--dry-run'],
        args,
      );
      assert.equal(args.cloud_command, 'init');
      assert.equal(args.wsl, true);
      assert.equal(args.windows_user, 'pikag');
      assert.equal(args.wsl_distro, 'Ubuntu');
      assert.equal(args.dry_run, true);
      assert.equal(args.ssh_user, 'ec2-user');
      assert.equal(args.func, parserHarness.sentinels.cmdDevboxSshConfig);
    },
  },
  {
    name: 'internal completion install parser accepts --shell',
    run: async () => {
      const args = {};
      const previous = process.env[INTERNAL_COMPLETION_INSTALL_ENV];
      process.env[INTERNAL_COMPLETION_INSTALL_ENV] = '1';
      try {
        parserHarness.parseInternalCompletionInstall(['--shell', 'zsh', '--quiet'], args);
      } finally {
        if (previous === undefined) {
          delete process.env[INTERNAL_COMPLETION_INSTALL_ENV];
        } else {
          process.env[INTERNAL_COMPLETION_INSTALL_ENV] = previous;
        }
      }
      assert.equal(args.shell, 'zsh');
      assert.equal(args.quiet, true);
      assert.equal(args.func, parserHarness.cmdCompletionInstall);
    },
  },
  {
    name: 'artifacts parser maps positional upload/download args',
    run: async () => {
      const uploadArgs = {};
      parserHarness.parseArtifacts(['upload', '--user-id', 'u123', 'bundle.tar.gz'], uploadArgs);
      assert.equal(uploadArgs.artifacts_command, 'upload');
      assert.equal(uploadArgs.user_id, 'u123');
      assert.equal(uploadArgs.file, 'bundle.tar.gz');
      assert.equal(uploadArgs.func, parserHarness.sentinels.cmdArtifactsUpload);

      const downloadArgs = {};
      parserHarness.parseArtifacts(['download', 'firmware.bin', '--user-id', 'u456'], downloadArgs);
      assert.equal(downloadArgs.artifacts_command, 'download');
      assert.equal(downloadArgs.user_id, 'u456');
      assert.equal(downloadArgs.filename, 'firmware.bin');
      assert.equal(downloadArgs.func, parserHarness.sentinels.cmdArtifactsDownload);
    },
  },
];

let passed = 0;
for (const testCase of cases) {
  try {
    await testCase.run();
    passed += 1;
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    console.error(`FAIL ${testCase.name}`);
    throw error;
  }
}

console.log(`Passed ${passed}/${cases.length} regression checks.`);

#!/usr/bin/env node

import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { promisify } from 'util';
import * as os from 'os';
import { Command } from 'commander';
import pkg from '../package.json';

const execAsync = promisify(exec);

const AGENT_PACKAGE = '@mariozechner/pi-coding-agent';

function getShellRcFile(): string {
  const platform = os.platform();
  if (platform === 'darwin') {
    return '.zshrc';
  }
  return '.bashrc';
}

function getPiHome(): string {
  const platform = os.platform();
  if (platform === 'darwin') {
    return '/Users/pi';
  }
  return '/home/pi';
}

function getPiInstallDir(): string {
  return `${getPiHome()}/pi`;
}

async function askQuestion(query: string, silent = false): Promise<string> {
  if (silent) {
    return new Promise<string>((resolve) => {
      process.stdout.write(query);
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf-8');
      let input = '';
      const onData = (char: string) => {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          stdin.removeListener('data', onData);
          stdin.setRawMode(wasRaw);
          stdin.pause();
          process.stdout.write('\n');
          resolve(input);
        } else if (char === '\u0003') {
          // Ctrl+C
          stdin.setRawMode(wasRaw);
          process.exit(1);
        } else if (char === '\u007F' || char === '\b') {
          input = input.slice(0, -1);
        } else {
          input += char;
        }
      };
      stdin.on('data', onData);
    });
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<string>((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const MAX_SUDO_RETRIES = 3;


// Cached sudo password so we only ask once
let cachedSudoPassword: string | null = null;

function runSudoWithPassword(command: string, password: string, asUser?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sudoArgs = ['-S', '-k'];
    if (asUser) {
      sudoArgs.push('-u', asUser);
    }
    sudoArgs.push('bash', '-c', command);
    const child = spawn('sudo', sudoArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: '/tmp',
    });
    child.stdin.write(password + '\n');
    child.stdin.end();

    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      const line = data.toString();
      // Filter out sudo's own password prompt
      if (!line.includes('Password:') && !line.includes('password for')) {
        stderr += line;
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        // Sanitize: never include the password in error messages
        const escaped = password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const safeStderr = stderr.replace(new RegExp(escaped, 'g'), '***');
        reject(new Error(`sudo command failed (exit code ${code}): ${safeStderr.trim()}`));
      }
    });
  });
}

async function askSudoPasswordAndRun(command: string, reason: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_SUDO_RETRIES; attempt++) {
    const password = await askQuestion(`Enter sudo password (${reason}): `, true);
    try {
      await runSudoWithPassword(command, password.trim());
      cachedSudoPassword = password.trim();
      return;
    } catch (e) {
      if (attempt < MAX_SUDO_RETRIES) {
        console.error('Incorrect password, please try again.');
      } else {
        throw new Error(`Failed after ${MAX_SUDO_RETRIES} attempts. Aborting.`);
      }
    }
  }
}

async function runAsPi(command: string): Promise<void> {
  if (!cachedSudoPassword) {
    const password = await askQuestion('Enter sudo password (required to run as pi): ', true);
    cachedSudoPassword = password.trim();
  }
  const piHome = getPiHome();
  // Set HOME and cd to pi's home to avoid inheriting the current user's
  // working directory (which pi can't access) and npm cache.
  const wrappedCommand = `export HOME=${piHome} && export npm_config_prefix=${piHome}/.npm-global && cd ${piHome} && ${command}`;
  await runSudoWithPassword(wrappedCommand, cachedSudoPassword, 'pi');
}

async function userExists(username: string): Promise<boolean> {
  try {
    await execAsync(`id -u ${username}`);
    return true;
  } catch {
    return false;
  }
}

async function ensurePiUser(): Promise<void> {
  const exists = await userExists('pi');
  if (exists) {
    console.log('User "pi" already exists.');
    return;
  }
  console.log('Creating user "pi"...');
  const platform = os.platform();
  if (platform === 'darwin') {
    await askSudoPasswordAndRun(
      `sysadminctl -addUser pi -home /Users/pi -shell /bin/zsh && createhomedir -c -u pi 2>/dev/null; mkdir -p /Users/pi && chown pi:staff /Users/pi`,
      'required to create user',
    );
  } else {
    await askSudoPasswordAndRun(
      `useradd -m -s /bin/bash pi`,
      'required to create user',
    );
  }
  console.log('User "pi" created.');
}

async function installAgent(): Promise<void> {
  const installDir = getPiInstallDir();
  const [scope, name] = AGENT_PACKAGE.split('/');
  const packageDir = path.join(installDir, 'node_modules', scope, name);
  if (fs.existsSync(packageDir)) {
    console.log(`${AGENT_PACKAGE} is already installed, skipping.`);
    return;
  }
  console.log(`Installing ${AGENT_PACKAGE} into ${installDir}...`);
  const cmd = `mkdir -p ${installDir} && cd ${installDir} && npm install ${AGENT_PACKAGE}`;
  await runAsPi(cmd);
  console.log('Package installed.');
}

async function updatePath(): Promise<void> {
  const rcFile = getShellRcFile();
  const piHome = getPiHome();
  const line = "export PATH=\$HOME/pi/node_modules/.bin:\$PATH";
  const rcPath = `${piHome}/${rcFile}`;

  // Check locally if the line is already present
  if (fs.existsSync(rcPath)) {
    const content = fs.readFileSync(rcPath, 'utf-8');
    if (content.includes(line)) {
      console.log(`pi's PATH already configured in ${rcFile}, skipping.`);
      return;
    }
  }

  console.log(`Adding agent binary directory to pi's PATH via ${rcFile}...`);
  const checkCmd = `grep -Fx '${line}' ${rcPath} 2>/dev/null || echo '${line}' >> ${rcPath}`;
  await runAsPi(checkCmd);
  console.log(`${rcFile} updated.`);
}

async function createLauncherScript(): Promise<void> {
  const currentUserHome = os.homedir();
  const binDir = path.join(currentUserHome, 'bin');
  const scriptPath = path.join(binDir, 'pi');
  const installDir = getPiInstallDir();

  console.log(`Creating launcher script at ${scriptPath}...`);

  // Create ~/bin/ if it doesn't exist
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  const piHome = getPiHome();
  const platform = os.platform();
  const homeBase = platform === 'darwin' ? '/Users' : '/home';

  // Write the launcher shell script with permission checks
  const scriptContent = `#!/bin/bash

echo "About to launch pi-coding-agent..."

# Check permissions of other users' home directories
EXPOSED_DIRS=()
HOME_BASE="${homeBase}"
PI_HOME="${piHome}"

for user_home in "$HOME_BASE"/*/; do
  # Skip pi's own home
  if [ "$user_home" = "$PI_HOME/" ]; then
    continue
  fi

  # Check if group or others have any permissions (r, w, or x)
  perms=$(stat -f "%Sp" "$user_home" 2>/dev/null || stat -c "%A" "$user_home" 2>/dev/null)
  if [ -z "$perms" ]; then
    continue
  fi

  # Extract group and others permissions (characters 5-10 of e.g. drwxr-xr-x)
  group_others="\${perms:4:6}"
  # Check if any of group/others have r, w, or x
  if echo "$group_others" | grep -q '[rwx]'; then
    # On macOS, handle /Users/Shared separately (it's world-accessible by default)
    if [ "$user_home" = "/Users/Shared/" ]; then
      echo "NOTE: /Users/Shared is world-accessible. This is a macOS default, but you may want to restrict it manually if it contains sensitive data."
      read -n 1 -s -r -p "Press any key to continue..."
      echo ""
    else
      EXPOSED_DIRS+=("$user_home")
    fi
  fi
done

if [ \${#EXPOSED_DIRS[@]} -gt 0 ]; then
  echo "WARNING: The following user home directories are accessible by other users (including pi):"
  for dir in "\${EXPOSED_DIRS[@]}"; do
    echo "  $dir"
  done
  echo ""
  read -p "Would you like to shield these directories? (recommended) [Y/n]" answer
  answer=\${answer:-Y}
  if [[ "$answer" =~ ^[Yy] ]]; then
    for dir in "\${EXPOSED_DIRS[@]}"; do
      sudo chmod go-rwx "$dir"
      echo "Shielded: $dir"
    done
    echo "Done."
  fi
  echo ""
fi

echo "Launching pi-coding-agent with pi user (sudo is required to impersonate 'pi' user)..."
exec sudo -i -u pi bash -c 'export npm_config_prefix=$HOME/.npm-global && cd ${installDir} && npx --yes ${AGENT_PACKAGE} "$@"' -- "$@"
`;
  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
  console.log('Launcher script created.');

  // Add $HOME/bin to the current user's PATH via their rc file if not already present
  const rcFile = getShellRcFile();
  const rcPath = path.join(currentUserHome, rcFile);
  const pathLine = 'export PATH="$HOME/bin:$PATH"';

  let rcContent = '';
  if (fs.existsSync(rcPath)) {
    rcContent = fs.readFileSync(rcPath, 'utf-8');
  }

  if (!rcContent.includes(pathLine)) {
    console.log(`Adding $HOME/bin to PATH in ${rcFile}...`);
    fs.appendFileSync(rcPath, `\n${pathLine}\n`);
    console.log(`${rcFile} updated.`);
  } else {
    console.log(`$HOME/bin already in PATH (${rcFile}).`);
  }
}

const RECOMMENDED_EXTENSIONS = ['npm:awto-pi-lot'];

async function installExtensions(): Promise<void> {
  const installDir = getPiInstallDir();
  for (const ext of RECOMMENDED_EXTENSIONS) {
    console.log(`Installing recommended extension: ${ext}...`);
    await runAsPi(`${installDir}/node_modules/.bin/pi install ${ext}`);
    console.log(`Extension ${ext} installed.`);
  }
}

async function launchAgent(): Promise<void> {
  const scriptPath = path.join(os.homedir(), 'bin', 'pi');
  const child = spawn(scriptPath, [], { stdio: 'inherit' });
  return new Promise<void>((resolve, reject) => {
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`pi-coding-agent exited with code ${code}`));
      }
    });
  });
}

async function configureAuth(): Promise<void> {
  const providerName = await askQuestion('Enter provider name: ');
  if (!providerName.trim()) {
    console.error('Provider name cannot be empty. Skipping auth configuration.');
    return;
  }
  const apiKey = await askQuestion('Enter API key: ');
  if (!apiKey.trim()) {
    console.error('API key cannot be empty. Skipping auth configuration.');
    return;
  }

  const authData = {
    [providerName.trim()]: {
      type: 'api_key',
      key: apiKey.trim(),
    },
  };

  const piHome = getPiHome();
  const agentDir = path.join(piHome, '.pi', 'agent');
  const authFilePath = path.join(agentDir, 'auth.json');
  const authJson = JSON.stringify(authData, null, 2);

  console.log(`Writing auth.json to ${agentDir}...`);
  await runAsPi(`mkdir -p ${agentDir} && cat > ${authFilePath} << 'SKYNOT_AUTH_EOF'
${authJson}
SKYNOT_AUTH_EOF
chmod 600 ${authFilePath}`);
  console.log('Auth configuration saved.');
}

async function wipeInstallation(): Promise<void> {
  const installDir = getPiInstallDir();
  if (fs.existsSync(installDir)) {
    console.log(`Wiping existing installation at ${installDir}...`);
    await runAsPi(`rm -rf ${installDir}`);
    console.log('Installation wiped.');
  } else {
    console.log('No existing installation found, nothing to wipe.');
  }
}

async function main() {
  if (os.platform() === 'win32') {
    throw new Error('Windows is not supported. Please run skynot on Linux or macOS.');
  }

  const program = new Command();
  program
    .version(pkg.version, '-V, --version', 'Output the version number')
    .description(pkg.description)
    .helpOption('-h, --help', 'Show this help message')
    .option('-u, --update', `Wipe and reinstall Pi, to get the latest version`)
    .option('-e, --extensions', `Install recommended extensions after installing Pi`)
    .option('-a, --auth', 'Configure provider authentication (creates auth.json for the pi user)');
  program.parse(process.argv);
  const opts = program.opts();

  await ensurePiUser();

  if (opts.update) {
    await wipeInstallation();
  }

  await installAgent();

  if (opts.extensions) {
    await installExtensions();
  }

  if (opts.auth) {
    await configureAuth();
  }

  await updatePath();
  await createLauncherScript();
  await launchAgent();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});

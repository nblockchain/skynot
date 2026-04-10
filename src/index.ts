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

function runSudoWithPassword(command: string, password: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('sudo', ['-S', '-k', 'bash', '-c', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
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
    await askSudoPasswordAndRun(`sysadminctl -addUser pi -home /Users/pi -shell /bin/zsh`, 'required to create user');
  } else {
    await askSudoPasswordAndRun('useradd -m -s /bin/bash pi', 'required to create user');
  }
  console.log('User "pi" created.');
}

async function installAgent(): Promise<void> {
  const installDir = getPiInstallDir();
  console.log(`Installing @mariozechner/pi-coding-agent into ${installDir}...`);
  const cmd = `mkdir -p ${installDir} && cd ${installDir} && npm install @mariozechner/pi-coding-agent`;
  try {
    await execAsync(`sudo -u pi bash -c '${cmd}'`);
  } catch (e) {
    await askSudoPasswordAndRun(
      `su -s /bin/bash pi -c '${cmd}'`,
      'required to install npm package as pi',
    );
  }
  console.log('Package installed.');
}

async function updatePath(): Promise<void> {
  const rcFile = getShellRcFile();
  const piHome = getPiHome();
  console.log(`Adding agent binary directory to pi's PATH via ${rcFile}...`);
  const line = "export PATH=\$HOME/pi/node_modules/.bin:\$PATH";
  const rcPath = `${piHome}/${rcFile}`;
  // Append line if not already present
  const checkCmd = `grep -Fx '${line}' ${rcPath} 2>/dev/null || echo '${line}' >> ${rcPath}`;
  try {
    await execAsync(`sudo -u pi bash -c "${checkCmd}"`);
  } catch (e) {
    await askSudoPasswordAndRun(
      `su -s /bin/bash pi -c "${checkCmd}"`,
      `required to modify ${rcFile}`,
    );
  }
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

  // Write the launcher shell script
  const scriptContent = `#!/bin/bash
exec sudo -u pi bash -c 'cd ${installDir} && npx pi-coding-agent "$@"' -- "$@"
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

async function launchAgent(): Promise<void> {
  console.log('Launching pi-coding-agent...');
  const installDir = getPiInstallDir();
  try {
    await execAsync(`sudo -u pi bash -c 'cd ${installDir} && npx pi-coding-agent'`);
  } catch (e) {
    await askSudoPasswordAndRun(
      `su -s /bin/bash pi -c 'cd ${installDir} && npx pi-coding-agent'`,
      'required to launch agent',
    );
  }
}

async function main() {
  if (os.platform() === 'win32') {
    throw new Error('Windows is not supported. Please run skynot on Linux or macOS.');
  }

  const program = new Command();
  program.version(pkg.version).description(pkg.description);
  program.parse(process.argv);

  await ensurePiUser();
  await installAgent();
  await updatePath();
  await createLauncherScript();
  await launchAgent();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});

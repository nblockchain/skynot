#!/usr/bin/env node

import { exec } from 'child_process';
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

async function askQuestion(query: string): Promise<string> {
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

async function runSudo(command: string, sudoPassword?: string): Promise<void> {
  // Use -S to read password from stdin if provided
  const fullCmd = sudoPassword ? `echo '${sudoPassword.replace(/'/g, `'\\''`)}' | sudo -S ${command}` : `sudo ${command}`;
  await execAsync(fullCmd, { stdio: 'inherit' });
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
  const password = await askQuestion('Enter sudo password (required to create user): ');
  const platform = os.platform();
  if (platform === 'darwin') {
    // macOS: use sysadminctl to create the user with a home directory and /bin/zsh shell
    await runSudo(`sysadminctl -addUser pi -home /Users/pi -shell /bin/zsh`, password.trim());
  } else {
    await runSudo('useradd -m -s /bin/bash pi', password.trim());
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
    const password = await askQuestion('Enter sudo password (required to install npm package as pi): ');
    await runSudo(`-u pi bash -c '${cmd}'`, password.trim());
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
    const password = await askQuestion(`Enter sudo password (required to modify ${rcFile}): `);
    await runSudo(`-u pi bash -c "${checkCmd}"`, password.trim());
  }
  console.log(`${rcFile} updated.`);
}

async function launchAgent(): Promise<void> {
  console.log('Launching pi-coding-agent...');
  try {
    const installDir = getPiInstallDir();
    await execAsync(`sudo -u pi bash -c 'cd ${installDir} && npx pi-coding-agent'`, { stdio: 'inherit' });
  } catch (e) {
    const installDir = getPiInstallDir();
    const password = await askQuestion('Enter sudo password (required to launch agent): ');
    await runSudo(`-u pi bash -c 'cd ${installDir} && npx pi-coding-agent'`, password.trim());
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
  await launchAgent();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});

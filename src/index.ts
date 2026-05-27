import {
    ChildProcess,
    ChildProcessWithoutNullStreams,
    exec,
    spawn,
    SpawnOptionsWithoutStdio,
} from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { promisify } from "util";
import * as os from "os";
import { Command } from "commander";
import {
    Option,
    Some,
    Nothing,
    None,
    OptionHelpers,
    Empty,
    TypeHelpers,
} from "fp-sdk";
import pkg from "../package.json";

const execAsync = promisify(exec);

const AGENT_NPM_PACKAGE = "@earendil-works/pi-coding-agent";
const AGENT_GITHUB_REPO = "earendil-works/pi";
const AGENT_USER = "aidev";
const LAUNCHER_SCRIPT_FILENAME = "spi";
const CONTEXT_LENS_SCRIPT_FILENAME = "cpi";
const AGENT_GROUP_NAME = "aiteam";
const DEFAULT_UMASK = "007";
const MIN_NODE_MAJOR_VERSION = 22;
const MIN_GIT_VERSION = [2, 46];

enum UnixBasedOS {
    Linux,
    MacOS,
}

class WindowsNotSupportedError extends Error {}

function checkOS(): UnixBasedOS {
    const platform = os.platform();
    if (platform === "win32") {
        throw new WindowsNotSupportedError(
            "Windows is not supported. Please run skynot on Linux or macOS."
        );
    }
    return platform === "darwin" ? UnixBasedOS.MacOS : UnixBasedOS.Linux;
}

// used IIFE pattern (lambda style) in order to use const+trycatch
const CURRENT_OS = (() => {
    try {
        return checkOS();
    } catch (err: any) {
        if (err instanceof WindowsNotSupportedError) {
            console.error(err.message);
            process.exit(1);
        }
        throw err;
    }
})();

type GithubApiReleasesJson = {
    assets: {
        name: string;
        browser_download_url: string;
    }[];
};

type RunProcessOptions = {
    cwd?: string;
    onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
    onError?: (
        child: ChildProcessWithoutNullStreams,
        code: number | null
    ) => Error;
    verboseStdOut?: boolean;
    verboseStdErr?: boolean;
};

function getProcessOptions(verbose?: boolean, cwd?: string) {
    const opts: RunProcessOptions = Empty.object();
    if (verbose) {
        opts.verboseStdErr = true;
        opts.verboseStdOut = true;
    }
    opts.cwd = cwd;
    return opts;
}

function runCommand(
    command: string,
    args: string[],
    options: RunProcessOptions
): Promise<void> {
    return new Promise((resolve, reject) => {
        const spawnOptions: SpawnOptionsWithoutStdio = {
            stdio: ["pipe", "pipe", "pipe"],
        };
        const cwd = OptionHelpers.ofObj(options.cwd);
        if (cwd instanceof Some) {
            spawnOptions.cwd = cwd.value;
        }
        const child = spawn(command, args, spawnOptions);

        const redirectStdOut = OptionHelpers.ofObj(options.verboseStdOut);
        if (redirectStdOut instanceof Some && redirectStdOut.value) {
            child.stdout.pipe(process.stdout);
        }
        const redirectStdErr = OptionHelpers.ofObj(options.verboseStdErr);
        if (redirectStdErr instanceof Some && redirectStdErr.value) {
            child.stderr.pipe(process.stderr);
        }

        const onSpawn = OptionHelpers.ofObj(options.onSpawn);
        if (onSpawn instanceof Some) {
            onSpawn.value(child);
        }

        child.on("error", (error: Error) => {
            reject(error);
        });

        child.on("close", (code: number | null) => {
            if (code === 0) {
                resolve();
            } else {
                const onError = OptionHelpers.ofObj(options.onError);
                if (onError instanceof None) {
                    reject(
                        new Error(
                            `command '${command}' failed (exit code ${code})`
                        )
                    );
                } else {
                    reject(onError.value(child, code));
                }
            }
        });
    });
}

function getShellRcFile(): string {
    if (CURRENT_OS === UnixBasedOS.MacOS) {
        return ".zshrc";
    }
    return ".bashrc";
}

const agentUserHome: string =
    CURRENT_OS === UnixBasedOS.MacOS
        ? `/Users/${AGENT_USER}`
        : `/home/${AGENT_USER}`;
const workDir: string = path.join(agentUserHome, "Work");

function getPiInstallDir(): string {
    return `${agentUserHome}/pi`;
}

async function askQuestion(query: string, silent = false): Promise<string> {
    if (silent) {
        return new Promise<string>((resolve) => {
            process.stdout.write(query);
            const stdin = process.stdin;
            const wasRaw = stdin.isRaw;
            stdin.setRawMode(true);
            stdin.resume();
            stdin.setEncoding("utf-8");
            let input = "";
            const onData = (char: string) => {
                if (char === "\n" || char === "\r" || char === "\u0004") {
                    stdin.removeListener("data", onData);
                    stdin.setRawMode(wasRaw);
                    stdin.pause();
                    process.stdout.write("\n");
                    resolve(input);
                } else if (char === "\u0003") {
                    // Ctrl+C
                    stdin.setRawMode(wasRaw);
                    process.exit(1);
                } else if (char === "\u007F" || char === "\b") {
                    input = input.slice(0, -1);
                } else {
                    input += char;
                }
            };
            stdin.on("data", onData);
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

async function runSudoWithPassword(
    command: string,
    password: string,
    asUser?: string,
    verbose?: boolean
): Promise<void> {
    const sudoArgs = ["-S", "-k"];
    if (asUser) {
        sudoArgs.push("-u", asUser);
    }
    sudoArgs.push("bash", "-c", command);

    let stderr = "";

    const onSpawn = (child: ChildProcessWithoutNullStreams) => {
        child.stdin.write(password + "\n");
        child.stdin.end();
        child.stderr.on("data", (data: Buffer) => {
            const line = data.toString();
            // Filter out sudo's own password prompt
            if (!line.includes("Password:") && !line.includes("password for")) {
                stderr += line;
                if (verbose) {
                    process.stderr.write(line);
                }
            }
        });
    };

    const onError = (
        child: ChildProcessWithoutNullStreams,
        code: number | null
    ) => {
        // Sanitize: never include the password in error messages
        let safeStderr = stderr;
        if (password !== Empty.string()) {
            const escaped = password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            safeStderr = stderr.replace(new RegExp(escaped, "g"), "***");
        }
        return new Error(
            `sudo command '${command}' failed (exit code ${code}): ${safeStderr.trim()}`
        );
    };

    const options: RunProcessOptions = {
        // this is a workaround to errors like 'shell-init: error retrieving current directory: getcwd: cannot access parent directories: Permission denied
        cwd: "/tmp",
        onSpawn: onSpawn,
        onError: onError,
        verboseStdOut: verbose,
    };

    await runCommand("sudo", sudoArgs, options);
}

// Cached sudo password so we only ask once
let cachedSudoPassword: Option<string> = Nothing;

// When true, never cache the sudo password — ask every time
let paranoidMode = false;

async function askSudoPasswordAndRun(
    command: string,
    reason: string,
    asUser?: string,
    verbose?: boolean
): Promise<void> {
    const MAX_SUDO_RETRIES = 3;
    if (!paranoidMode && cachedSudoPassword instanceof Some) {
        await runSudoWithPassword(
            command,
            cachedSudoPassword.value,
            asUser,
            verbose
        );
        return;
    }
    for (let attempt = 1; attempt <= MAX_SUDO_RETRIES; attempt++) {
        const password = await askQuestion(
            `Enter sudo password (${reason}) [exact command: \`${command}\`]: `,
            true
        );
        try {
            // Validate the password with a trivial command first
            await runSudoWithPassword("ls /", password);
        } catch (e) {
            if (attempt < MAX_SUDO_RETRIES) {
                console.error("Incorrect password, please try again.");
                continue;
            } else {
                throw new Error(
                    `Failed after ${MAX_SUDO_RETRIES} attempts. Aborting.`
                );
            }
        }
        if (!paranoidMode) {
            cachedSudoPassword = new Some(password);
        }

        // Password is valid, now run the actual command
        await runSudoWithPassword(command, password, asUser, verbose);
        return;
    }
}

async function runAsAgentUser(
    command: string,
    verbose?: boolean
): Promise<void> {
    // Set HOME and cd to the agent user's home to avoid inheriting the current user's
    // working directory (which the agent user can't access) and npm cache.
    const wrappedCommand = `export HOME=${agentUserHome} && export npm_config_prefix=${agentUserHome}/.npm-global && umask ${DEFAULT_UMASK} && cd ${agentUserHome} && ${command}`;
    await askSudoPasswordAndRun(
        wrappedCommand,
        `required to run as '${AGENT_USER}' user`,
        AGENT_USER,
        verbose
    );
}

async function userExists(username: string): Promise<boolean> {
    try {
        await execAsync(`id -u ${username}`);
        return true;
    } catch {
        return false;
    }
}

async function groupExists(groupName: string): Promise<boolean> {
    try {
        if (CURRENT_OS === UnixBasedOS.MacOS) {
            await execAsync(`dscl . -read /Groups/${groupName}`);
        } else {
            await execAsync(`getent group ${groupName}`);
        }
        return true;
    } catch {
        return false;
    }
}

async function ensureAgentUserExists(): Promise<void> {
    const exists = await userExists(AGENT_USER);
    if (exists) {
        console.log(`User "${AGENT_USER}" already exists.`);
        return;
    }
    console.log(`Creating user "${AGENT_USER}"...`);
    if (CURRENT_OS === UnixBasedOS.MacOS) {
        await askSudoPasswordAndRun(
            `sysadminctl -addUser ${AGENT_USER} -home ${agentUserHome} -shell /bin/zsh`,
            "required to create user"
        );
        await askSudoPasswordAndRun(
            `createhomedir -c -u ${AGENT_USER} || mkdir -p ${agentUserHome}`,
            "required to create home directory"
        );
        await askSudoPasswordAndRun(
            `chown ${AGENT_USER}:${AGENT_GROUP_NAME} ${agentUserHome}`,
            "required to set home directory ownership"
        );
        await askSudoPasswordAndRun(
            `chgrp ${AGENT_GROUP_NAME} ${agentUserHome}`,
            "required to set home directory group"
        );
        await askSudoPasswordAndRun(
            `chmod g+s ${agentUserHome}`,
            "required to set setgid bit on home directory"
        );
        await askSudoPasswordAndRun(
            `chmod +a "group:${AGENT_GROUP_NAME} allow list,add_file,search,add_subdirectory,file_inherit,directory_inherit" ${agentUserHome}`,
            "required to set ACL on home directory for group write inheritance"
        );
    } else {
        await askSudoPasswordAndRun(
            `useradd -m -s /bin/bash -g ${AGENT_GROUP_NAME} ${AGENT_USER}`,
            "required to create user"
        );
        await askSudoPasswordAndRun(
            `chgrp ${AGENT_GROUP_NAME} ${agentUserHome}`,
            "required to set home directory group"
        );
        await askSudoPasswordAndRun(
            `chmod g+s ${agentUserHome}`,
            "required to set setgid bit on home directory"
        );
        await askSudoPasswordAndRun(
            `setfacl -d -m g::rwx ${agentUserHome}`,
            "required to set default ACL on home directory for group write"
        );
    }
    console.log(`User "${AGENT_USER}" created.`);
}

// Add a sudoers file that allows the current user to run commands as the '${AGENT_USER}' user without a password.
async function addSudoersEntry(): Promise<void> {
    const currentUser = os.userInfo().username;
    const sudoersPath = `/etc/sudoers.d/pi-${AGENT_USER}`;
    const line = `${currentUser} ALL=( ${AGENT_USER} ) NOPASSWD: ALL`;
    // Create or overwrite the sudoers file and set proper permissions (440)
    const cmd = `echo '${line}' | tee ${sudoersPath} && chmod 440 ${sudoersPath}`;
    await askSudoPasswordAndRun(
        cmd,
        `required to add sudoers entry for ${currentUser} to run as ${AGENT_USER} without password`
    );
    console.log(
        `Sudoers entry added for ${currentUser} to run as ${AGENT_USER} without password.`
    );
}

async function installAgentUsingNpm(verbose?: boolean): Promise<void> {
    const installDir = getPiInstallDir();
    const [scope, name] = AGENT_NPM_PACKAGE.split("/");
    const packageDir = path.join(installDir, "node_modules", scope, name);
    if (fs.existsSync(packageDir)) {
        console.log(`${AGENT_NPM_PACKAGE} is already installed, skipping.`);
        return;
    }
    console.log(`Installing ${AGENT_NPM_PACKAGE} into ${installDir}...`);
    const npmLogLevel = verbose ? " --loglevel info" : "";
    const cmd = `mkdir -p ${installDir} && cd ${installDir} && npm install${npmLogLevel} ${AGENT_NPM_PACKAGE}`;
    await runAsAgentUser(cmd, verbose);
    console.log("Package installed.");
}

async function checkNodeVersion(
    label: string,
    commandPrefix?: string
): Promise<void> {
    const nodeVersionCmd = "node --version";
    const cmd = commandPrefix
        ? `${commandPrefix} ${nodeVersionCmd}`
        : nodeVersionCmd;
    try {
        const { stdout } = await execAsync(cmd);
        const version = stdout.trim().replace(/^v/, "");
        const major = parseInt(version.split(".")[0], 10);
        if (isNaN(major) || major < MIN_NODE_MAJOR_VERSION) {
            console.error(
                `Error: NodeJS version ${version} for ${label} is less than required v${MIN_NODE_MAJOR_VERSION}.x`
            );
            process.exit(1);
        }
    } catch {
        console.error(
            `Error: NodeJS not found for ${label}. Please install Node.js v${MIN_NODE_MAJOR_VERSION} or newer.`
        );
        process.exit(1);
    }
}

async function checkWget(): Promise<void> {
    try {
        await execAsync("which wget");
    } catch (err) {
        console.error(
            "Error: wget not found. Either install wget or use --npm flag."
        );
        process.exit(1);
    }
}

async function checkMitmProxy(): Promise<void> {
    try {
        await execAsync("which mitmproxy");
    } catch (err) {
        const installHint =
            os.platform() == "darwin"
                ? "e.g., 'brew install mitmproxy'"
                : "e.g., 'apt install mitmproxy' on Debian/Ubuntu";
        console.error(
            `Error: mitmproxy not found. It is needed to use skynot with context-lens. Please install it (${installHint}).`
        );
        process.exit(1);
    }
}

async function installAgentFromTarball(
    update: boolean,
    verbose?: boolean
): Promise<void> {
    const piInstallDir = getPiInstallDir();
    const platform = os.platform();
    const arch = os.arch();
    const tarballName = `pi-${platform}-${arch}.tar.gz`;

    if (!update && fs.existsSync(piInstallDir)) {
        console.log(`Pi is already installed, skipping.`);
        return;
    }

    console.log(`Installing ${tarballName} into ${piInstallDir}...`);

    const releasesUrl = `https://api.github.com/repos/${AGENT_GITHUB_REPO}/releases/latest`;
    const response = await fetch(releasesUrl);
    if (!response.ok) {
        throw new Error(`Error when getting releases: ${response.status}`);
    }
    const releasesJson = (await response.json()) as GithubApiReleasesJson;

    const assets = releasesJson.assets;
    const asset = OptionHelpers.ofObj(
        assets.find((asset) => asset.name === tarballName)
    );
    if (asset instanceof None) {
        throw new Error(
            `Asset with tarball ${tarballName} not found in the list of release assets.`
        );
    }
    const assetUrl = asset.value.browser_download_url;

    const tarballPath = path.join("/var/tmp", tarballName);
    // wget shows progeress in stderr
    const wgetProcessOptions = {
        verboseStdOut: verbose,
        verboseStdErr: verbose,
    };
    const wgetCommandArgs = [assetUrl, `--output-document=${tarballPath}`];
    if (!verbose) {
        wgetCommandArgs.push("--quiet");
    }
    await runCommand("wget", wgetCommandArgs, wgetProcessOptions);

    if (update) {
        await wipeInstallation();
    }

    const tarVerboseFlag = verbose ? "--verbose" : "";
    const cmd = `cd ${agentUserHome} && tar --extract --gzip ${tarVerboseFlag} --file ${tarballPath}`;
    await runAsAgentUser(cmd, verbose);
    console.log(`Installed Pi from tarball.`);
}

async function updatePath(): Promise<void> {
    const rcFile = getShellRcFile();
    const line = `export PATH=\$HOME/${AGENT_USER}/node_modules/.bin:\$PATH`;
    const rcPath = `${agentUserHome}/${rcFile}`;

    // Check locally if the line is already present
    if (fs.existsSync(rcPath)) {
        const content = fs.readFileSync(rcPath, "utf-8");
        if (content.includes(line)) {
            console.log(
                `${AGENT_USER}'s PATH already configured in ${rcFile}, skipping.`
            );
            return;
        }
    }

    console.log(
        `Adding agent binary directory to ${AGENT_USER}'s PATH via ${rcFile}...`
    );
    const checkCmd = `grep -Fx '${line}' ${rcPath} 2>/dev/null || echo '${line}' >> ${rcPath}`;
    await runAsAgentUser(checkCmd);
    console.log(`${rcFile} updated.`);
}

async function updateAgentUserUmask(): Promise<void> {
    const rcFile = getShellRcFile();
    const line = `umask ${DEFAULT_UMASK}`;
    const rcPath = `${agentUserHome}/${rcFile}`;

    // Check locally if the line is already present
    if (fs.existsSync(rcPath)) {
        const content = fs.readFileSync(rcPath, "utf-8");
        if (content.includes(line)) {
            console.log(
                `${AGENT_USER}'s umask already configured in ${rcFile}, skipping.`
            );
            return;
        }
    }

    console.log(
        `Setting umask ${DEFAULT_UMASK} in ${AGENT_USER}'s ${rcFile}...`
    );
    const checkCmd = `grep -Fx '${line}' ${rcPath} 2>/dev/null || echo '${line}' >> ${rcPath}`;
    await runAsAgentUser(checkCmd);
    console.log(`${rcFile} updated with umask.`);
}

async function setupUmaskScriptForCurrentUser(): Promise<void> {
    const currentUserHome = os.homedir();
    const rcFile = getShellRcFile();
    const binDir = path.join(currentUserHome, "bin");
    const scriptPath = path.join(binDir, "ai-umask.sh");
    const rcPath = path.join(currentUserHome, rcFile);
    const sourceLine = `[ -f ~/bin/ai-umask.sh ] && source ~/bin/ai-umask.sh`;

    // Ensure bin directory exists
    if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
    }

    const scriptContent = `#!/bin/bash
ORIGINAL_UMASK=\$(umask)

function set_dir_umask {
    if [[ "\$PWD" == "${workDir}"* ]]; then
        # ug+rwx , o-rwx ; result= 770
        umask 007
    else
        umask "\$ORIGINAL_UMASK"
    fi
}

if [ -n "\$ZSH_VERSION" ]; then
    autoload -Uz add-zsh-hook
    add-zsh-hook chpwd set_dir_umask
elif [ -n "\$BASH_VERSION" ]; then
    if [[ "\$PROMPT_COMMAND" != *"set_dir_umask"* ]]; then
        PROMPT_COMMAND="set_dir_umask\${PROMPT_COMMAND:+; \$PROMPT_COMMAND}"
    fi
fi

set_dir_umask
`;

    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

    // Check if already in rc file
    let rcContent = "";
    if (fs.existsSync(rcPath)) {
        rcContent = fs.readFileSync(rcPath, "utf-8");
    }

    if (rcContent.includes(sourceLine)) {
        console.log(`Umask script already sourced in ${rcFile}, skipping.`);
        return;
    }

    console.log(`Adding umask script source to current user's ${rcFile}...`);
    fs.appendFileSync(rcPath, `\n${sourceLine}\n`);
    console.log(`${rcFile} updated with umask script.`);
}

function getExportPrefix(
    apiKeyExport: Option<{ name: string; value: string }> = Nothing
) {
    return apiKeyExport instanceof Some
        ? `export ${apiKeyExport.value.name}=${apiKeyExport.value.value} && `
        : Empty.string();
}

async function createLauncherScript(
    command: string,
    scriptFileName: string,
    apiKeyExport: Option<{ name: string; value: string }> = Nothing
): Promise<void> {
    const currentUserHome = os.homedir();
    const binDir = path.join(currentUserHome, "bin");
    const scriptPath = path.join(binDir, scriptFileName);

    console.log(`Creating launcher script at ${scriptPath}...`);

    // Create ~/bin/ if it doesn't exist
    if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
    }

    const homeBase = CURRENT_OS === UnixBasedOS.MacOS ? "/Users" : "/home";

    // Write the launcher shell script with permission checks
    const scriptContent = `#!/bin/bash

CURRENT_DIR=$PWD

# Ensure CURRENT_DIR is inside workDir
case "$CURRENT_DIR" in
  ${workDir}|${workDir}/*)
    ;; # OK
  *)
    echo "Error: Current directory ($CURRENT_DIR) is not inside ${workDir}."
    echo "Please launch from a directory with proper permissions (e.g. ${workDir})."
    exit 1
    ;;
esac

echo "About to launch Pi..."

# Check permissions of other users' home directories
EXPOSED_DIRS=()
HOME_BASE="${homeBase}"
AGENT_USER_HOME="${agentUserHome}"

for user_home in "$HOME_BASE"/*/; do
  # Skip ${AGENT_USER}'s own home
  if [ "$user_home" = "$AGENT_USER_HOME/" ]; then
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
  echo "WARNING: The following user home directories are accessible by other users (including '${AGENT_USER}' user):"
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

${command}
`;
    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
    console.log("Launcher script created.");

    // Add $HOME/bin to the current user's PATH via their rc file if not already present
    const rcFile = getShellRcFile();
    const rcPath = path.join(currentUserHome, rcFile);
    const pathLine = 'export PATH="$HOME/bin:$PATH"';

    let rcContent = "";
    if (fs.existsSync(rcPath)) {
        rcContent = fs.readFileSync(rcPath, "utf-8");
    }

    if (!rcContent.includes(pathLine)) {
        console.log(`Adding $HOME/bin to PATH in ${rcFile}...`);
        fs.appendFileSync(rcPath, `\n${pathLine}\n`);
        console.log(`${rcFile} updated.`);
    } else {
        console.log(`$HOME/bin already in PATH (${rcFile}).`);
    }
}

async function createPiLauncherScript(
    piBinaryPath: string,
    apiKeyExport: Option<{ name: string; value: string }> = Nothing
): Promise<void> {
    const exportPrefix = getExportPrefix(apiKeyExport);
    const command = `
PROXY_ENV=""
[ -n "$https_proxy" ] && PROXY_ENV="$PROXY_ENV export https_proxy=\\"$https_proxy\\" &&"
[ -n "$HTTPS_PROXY" ] && PROXY_ENV="$PROXY_ENV export HTTPS_PROXY=\\"$HTTPS_PROXY\\" &&"
[ -n "$NPM_CONFIG_HTTPS_PROXY" ] && PROXY_ENV="$PROXY_ENV export NPM_CONFIG_HTTPS_PROXY=\\"$NPM_CONFIG_HTTPS_PROXY\\" &&"
[ -n "$WSS_PROXY" ] && PROXY_ENV="$PROXY_ENV export WSS_PROXY=\\"$WSS_PROXY\\" &&"
[ -n "$NODE_USE_ENV_PROXY" ] && PROXY_ENV="$PROXY_ENV export NODE_USE_ENV_PROXY=\\"$NODE_USE_ENV_PROXY\\" &&"
[ -n "$SSL_CERT_FILE" ] && PROXY_ENV="$PROXY_ENV export SSL_CERT_FILE=\\"$SSL_CERT_FILE\\" &&"
[ -n "$NODE_EXTRA_CA_CERTS" ] && PROXY_ENV="$PROXY_ENV export NODE_EXTRA_CA_CERTS=\\"$NODE_EXTRA_CA_CERTS\\" &&"
[ -n "$REQUESTS_CA_BUNDLE" ] && PROXY_ENV="$PROXY_ENV export REQUESTS_CA_BUNDLE=\\"$REQUESTS_CA_BUNDLE\\" &&"

FULL_SUDO_CMD="\${exportPrefix}\$PROXY_ENV export npm_config_prefix=$AGENT_USER_HOME/.npm-global && umask ${DEFAULT_UMASK} && cd $CURRENT_DIR && ${piBinaryPath} \$@"
echo "Launching Pi with ${AGENT_USER} user (sudo is required to impersonate '${AGENT_USER}' user)..."
exec sudo -i -u ${AGENT_USER} bash -c "$FULL_SUDO_CMD"`;
    await createLauncherScript(command, LAUNCHER_SCRIPT_FILENAME, apiKeyExport);
}

async function createContextLensLauncherScript(
    contextLensDir: string,
    apiKeyExport: Option<{ name: string; value: string }> = Nothing
): Promise<void> {
    const cmd = `HOME=${agentUserHome} node ${contextLensDir}/dist/cli.js --mitm spi`;
    const exportPrefix = getExportPrefix(apiKeyExport);
    const command = `
echo "Launching Pi using context-lens wrapper..."
echo "The context-lens UI is available at http://localhost:4041/"
export PATH=$PATH:$HOME/bin
${exportPrefix}cd "$CURRENT_DIR" && ${cmd} "$@"`;
    await createLauncherScript(
        command,
        CONTEXT_LENS_SCRIPT_FILENAME,
        apiKeyExport
    );
}

async function createMacOsGroup(
    sudoReason: string,
    freeGroupIdFindingCount: number
): Promise<void> {
    if (freeGroupIdFindingCount == 0) {
        await askSudoPasswordAndRun(
            `dscl . -create /Groups/${AGENT_GROUP_NAME}`,
            sudoReason
        );
        console.log(
            `Group "${AGENT_GROUP_NAME}" created without group assignment yet`
        );
    }

    const maxTriesForFindingAFreeGroupId = 50;

    // some SO post recommends giving gids between 100-499: https://superuser.com/a/1842207
    const gid = 444 - freeGroupIdFindingCount;

    try {
        await askSudoPasswordAndRun(
            `dscl . -create /Groups/${AGENT_GROUP_NAME} gid ${gid}`,
            sudoReason
        );
        console.log(`Group "${AGENT_GROUP_NAME}" created (group ID: ${gid}).`);
    } catch (createErr: unknown) {
        const errMsg =
            createErr instanceof Error ? createErr.message : String(createErr);
        if (
            errMsg.includes("eDSRecordAlreadyExists") ||
            errMsg.includes("already exists")
        ) {
            if (freeGroupIdFindingCount > maxTriesForFindingAFreeGroupId) {
                throw Error("Could not find a free gid for new group");
            } else {
                return createMacOsGroup(
                    sudoReason,
                    freeGroupIdFindingCount + 1
                );
            }
        }
    }
}

async function ensureAgentGroupExists(): Promise<void> {
    const exists = await groupExists(AGENT_GROUP_NAME);
    if (exists) {
        console.log(`Group "${AGENT_GROUP_NAME}" already exists.`);
        return;
    }
    console.log(`Creating group "${AGENT_GROUP_NAME}"...`);
    const reason = `required to create ${AGENT_GROUP_NAME} group`;
    if (CURRENT_OS === UnixBasedOS.MacOS) {
        await createMacOsGroup(reason, 0);
    } else {
        await askSudoPasswordAndRun(`groupadd ${AGENT_GROUP_NAME}`, reason);
        console.log(`Group "${AGENT_GROUP_NAME}" created.`);
    }
}

async function ensureUserInGroup(user: string): Promise<void> {
    try {
        const { stdout } = await execAsync(`id -nG ${user}`);
        if (stdout.split(/\s+/).includes(AGENT_GROUP_NAME)) {
            console.log(
                `User "${user}" is already in group "${AGENT_GROUP_NAME}".`
            );
            return;
        }
    } catch {
        // user might not exist yet or id failed, try to add anyway
    }
    console.log(`Adding user "${user}" to group "${AGENT_GROUP_NAME}"...`);
    if (CURRENT_OS === UnixBasedOS.MacOS) {
        await askSudoPasswordAndRun(
            `dseditgroup -o edit -a ${user} -t user ${AGENT_GROUP_NAME}`,
            `required to add ${user} to ${AGENT_GROUP_NAME} group`
        );
    } else {
        await askSudoPasswordAndRun(
            `usermod -aG ${AGENT_GROUP_NAME} ${user}`,
            `required to add ${user} to ${AGENT_GROUP_NAME} group`
        );
    }
    console.log(`User "${user}" added to group "${AGENT_GROUP_NAME}".`);
}

async function ensureExclusiveGroupMembership(user: string): Promise<void> {
    try {
        const { stdout } = await execAsync(`id -nG ${user}`);
        // In macOS, these are special default groups. Even if you remove the user
        // from them, it either fails silently or they get automatically re-added.
        // Thus, we must ignore them here.
        const MAC_OS_DEFAULT_GROUPS = [
            "everyone",
            "localaccounts",
            "com.apple.sharepoint.group.1",
            "_lpoperator",
        ];

        const groups = stdout
            .trim()
            .split(/\s+/)
            .filter(
                (g) =>
                    g !== AGENT_GROUP_NAME &&
                    !(
                        CURRENT_OS === UnixBasedOS.MacOS &&
                        MAC_OS_DEFAULT_GROUPS.includes(g)
                    )
            );
        if (groups.length === 0) {
            console.log(
                `User "${user}" already belongs exclusively to group "${AGENT_GROUP_NAME}".`
            );
            return;
        }
        console.log(
            `Removing user "${user}" from extra groups: ${groups.join(", ")}...`
        );
        if (CURRENT_OS === UnixBasedOS.MacOS) {
            // macOS: remove from each extra group individually and set primary group
            for (const group of groups) {
                try {
                    await askSudoPasswordAndRun(
                        `dseditgroup -o edit -d ${user} -t user ${group}`,
                        `required to remove ${user} from group ${group}`
                    );
                } catch {
                    // Group may not exist in directory services (e.g. implicit primary group), skip
                }
            }
            // Set primary group to AGENT_GROUP_NAME
            await askSudoPasswordAndRun(
                `dscl . -create /Users/${user} PrimaryGroupID $(dscl . -read /Groups/${AGENT_GROUP_NAME} PrimaryGroupID | awk '{print $2}')`,
                `required to set primary group for ${user}`
            );
        } else {
            // Linux: set primary and supplementary groups to only AGENT_GROUP_NAME
            await askSudoPasswordAndRun(
                `usermod -g ${AGENT_GROUP_NAME} -G ${AGENT_GROUP_NAME} ${user}`,
                `required to set exclusive group membership for ${user}`
            );
        }
        console.log(
            `User "${user}" now belongs exclusively to group "${AGENT_GROUP_NAME}".`
        );
    } catch (err) {
        console.error(
            `Warning: could not verify/set exclusive group membership for "${user}": ${err}`
        );
    }
}

async function setupWorkDir(): Promise<string> {
    console.log(`Setting up group permissions...`);
    await askSudoPasswordAndRun(
        `chown ${AGENT_USER}:${AGENT_GROUP_NAME} ${agentUserHome} && chmod g+rwxs ${agentUserHome}`,
        `required to set ${AGENT_USER}'s home to belong to ${AGENT_GROUP_NAME} group`
    );
    if (CURRENT_OS === UnixBasedOS.MacOS) {
        await askSudoPasswordAndRun(
            `ls -led ${agentUserHome} | grep -q "group:${AGENT_GROUP_NAME}" || chmod +a "group:${AGENT_GROUP_NAME} allow list,add_file,search,add_subdirectory,file_inherit,directory_inherit" ${agentUserHome}`,
            "required to ensure ACL on home directory for group write inheritance"
        );
    } else {
        await askSudoPasswordAndRun(
            `setfacl -d -m g::rwx ${agentUserHome}`,
            "required to ensure default ACL on home directory for group write"
        );
    }

    // Create work directory owned by ${AGENT_USER}:${AGENT_GROUP_NAME} with group rwx and setgid
    console.log(`Setting up work directory at ${workDir}...`);
    await askSudoPasswordAndRun(
        `mkdir -p ${workDir} && chown ${AGENT_USER}:${AGENT_GROUP_NAME} ${workDir} && chmod g+rwxs ${workDir}`,
        "required to set up work directory"
    );
    if (CURRENT_OS === UnixBasedOS.MacOS) {
        await askSudoPasswordAndRun(
            `ls -led ${workDir} | grep -q "group:${AGENT_GROUP_NAME}" || chmod +a "group:${AGENT_GROUP_NAME} allow list,add_file,search,add_subdirectory,file_inherit,directory_inherit" ${workDir}`,
            "required to ensure ACL on work directory for group write inheritance"
        );
    } else {
        await askSudoPasswordAndRun(
            `setfacl -d -m g::rwx ${workDir}`,
            "required to ensure default ACL on work directory for group write"
        );
    }
    // Mark all directories under the work directory as safe for git
    const safeDirectoryCmd = `git config --global --add safe.directory '${workDir}/*'`;
    await runAsAgentUser(safeDirectoryCmd);
    await execAsync(safeDirectoryCmd);
    console.log(
        `Adjusted git settings for '${workDir}/*' to allow working together between '${AGENT_USER}' and current user.`
    );

    console.log("Work directory ready.");

    return workDir;
}

const RECOMMENDED_EXTENSIONS = [
    "npm:awto-pi-lot",

    // BEWARE: this extension doesn't have NPM Provenance enabled yet:
    "npm:pi-wtf",
];

async function installExtensions(
    piBinaryPath: string,
    verbose?: boolean
): Promise<void> {
    for (const ext of RECOMMENDED_EXTENSIONS) {
        console.log(`Installing recommended extension: ${ext}...`);
        await runAsAgentUser(`${piBinaryPath} install ${ext}`, verbose);
        console.log(`Extension ${ext} installed.`);
    }
}

async function buildContextLens(
    contextLensDir: string,
    verbose?: boolean
): Promise<void> {
    console.log("Building context-lens...");
    const commandOptions = getProcessOptions(verbose);

    let usePnpm = false;
    try {
        await execAsync("which pnpm");
        usePnpm = true;
    } catch {
        // pnpm is not available
    }

    if (usePnpm) {
        for (const dir of [contextLensDir, path.join(contextLensDir, "ui")]) {
            commandOptions.cwd = dir;
            await runCommand("pnpm", ["install"], commandOptions);
            await runCommand("pnpm", ["run", "build"], commandOptions);
        }
    } else {
        commandOptions.cwd = contextLensDir;
        await runCommand("npm", ["install"], commandOptions);
        await runCommand("npm", ["run", "generate:version"], commandOptions);
        await runCommand("npm", ["run", "generate:types"], commandOptions);
        await runCommand("npx", ["tsc"], commandOptions);

        commandOptions.cwd = path.join(contextLensDir, "ui");
        await runCommand("npm", ["install"], commandOptions);
        await runCommand("npm", ["run", "build"], commandOptions);
    }

    console.log("context-lens built.");
}

async function installContextLens(
    update: boolean,
    apiKeyExport: Option<{ name: string; value: string }> = Nothing,
    verbose?: boolean
): Promise<void> {
    const contextLensRepoName = "context-lens";
    const contextLensGithubRepoUrl = `https://github.com/larsderidder/${contextLensRepoName}.git`;
    const contextLensDir = path.join(agentUserHome, contextLensRepoName);
    const commandOptions = getProcessOptions(verbose, agentUserHome);
    const commandOptionsForContextLensDir = getProcessOptions(
        verbose,
        contextLensDir
    );

    async function applyPatches() {
        const patchesDir = path.join(__dirname, "..", "context-lens-patches");
        const patchFiles = fs
            .readdirSync(patchesDir)
            .filter((fileName) => fileName.endsWith(".patch"));

        for (const patchFile of patchFiles) {
            const patchPath = path.join(patchesDir, patchFile);
            console.log(`Applying patch: ${patchFile}`);
            await runCommand(
                "git",
                ["apply", patchPath],
                commandOptionsForContextLensDir
            );
        }
    }

    if (fs.existsSync(contextLensDir)) {
        console.log("context-lens already installed.");
        const cliPath = path.join(contextLensDir, "dist", "cli.js");
        const uiDistPath = path.join(contextLensDir, "ui", "dist");
        if (update || !fs.existsSync(cliPath) || !fs.existsSync(uiDistPath)) {
            console.log("Updating or building missing context-lens distribution...");
            if (update) {
                await runCommand("git", ["fetch"], commandOptionsForContextLensDir);
                await runCommand(
                    "git",
                    ["reset", "--hard", "origin/main"],
                    commandOptionsForContextLensDir
                );
                await applyPatches();
            }
            await buildContextLens(contextLensDir, verbose);
            console.log("context-lens built successfully.");
        }
    } else {
        console.log("Installing context-lens...");
        await runCommand(
            "git",
            ["clone", contextLensGithubRepoUrl],
            commandOptions
        );

        await applyPatches();

        await buildContextLens(contextLensDir, verbose);
        console.log("context-lens installed.");
    }

    await createContextLensLauncherScript(contextLensDir, apiKeyExport);
}

async function launchAgent(): Promise<void> {
    const scriptPath = path.join(os.homedir(), "bin", LAUNCHER_SCRIPT_FILENAME);
    const child = spawn(scriptPath, [], { stdio: "inherit" });
    return new Promise<void>((resolve, reject) => {
        child.on("close", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Pi exited with code ${code}`));
            }
        });
    });
}

async function configureAuth(): Promise<
    Option<{ name: string; value: string }>
> {
    while (true) {
        const input = await askQuestion(
            "Enter provider name (lowercase) or auth env var name (uppercase): "
        );
        const trimmed = input.trim();

        if (trimmed === Empty.string()) {
            console.error(
                "Input cannot be empty. Skipping auth configuration."
            );
            return Nothing;
        }

        const hasLowercase = /[a-z]/.test(trimmed);
        const hasUppercase = /[A-Z]/.test(trimmed);

        if (
            (hasLowercase && hasUppercase) ||
            (!hasLowercase && !hasUppercase)
        ) {
            console.error(
                "Error: input must be either all lowercase (provider name) or all uppercase (env var name). Please try again."
            );
            continue;
        }

        if (hasLowercase) {
            // Provider name mode: create auth.json
            const apiKey = await askQuestion("Enter API key: ");
            if (apiKey.trim() === Empty.string()) {
                console.error(
                    "API key cannot be empty. Skipping auth configuration."
                );
                return Nothing;
            }

            const authData = {
                [trimmed]: {
                    type: "api_key",
                    key: apiKey.trim(),
                },
            };

            const agentDir = path.join(agentUserHome, ".pi", "agent");
            const authFilePath = path.join(agentDir, "auth.json");
            const authJson = JSON.stringify(authData, null, 2);

            console.log(`Writing auth.json to ${agentDir}...`);
            await runAsAgentUser(`mkdir -p ${agentDir} && cat > ${authFilePath} << 'SKYNOT_AUTH_EOF'
${authJson}
SKYNOT_AUTH_EOF
chmod 600 ${authFilePath}`);
            console.log("Auth configuration saved.");
            return Nothing;
        }

        // Uppercase only: env var mode
        if (!trimmed.endsWith("_API_KEY")) {
            const answer = await askQuestion(
                `"${trimmed}" does not end with "_API_KEY". Did you misspell the env var name? (y/n, or press Enter to retry): `
            );
            if (answer.trim().toLowerCase() !== "y") {
                continue;
            }
        }

        const apiKey = await askQuestion("Enter API key: ");
        if (apiKey.trim() === Empty.string()) {
            console.error(
                "API key cannot be empty. Skipping auth configuration."
            );
            return Nothing;
        }

        return new Some({ name: trimmed, value: apiKey.trim() });
    }
}

async function copySshKeys(): Promise<void> {
    const currentUserHome = os.homedir();
    const sshDir = path.join(currentUserHome, ".ssh");
    const privateKey = path.join(sshDir, "id_rsa");
    const publicKey = path.join(sshDir, "id_rsa.pub");

    if (!fs.existsSync(privateKey) || !fs.existsSync(publicKey)) {
        console.error(
            "SSH keys not found at ~/.ssh/id_rsa and ~/.ssh/id_rsa.pub. Skipping SSH setup."
        );
        return;
    }

    const agentUserSshDir = path.join(agentUserHome, ".ssh");

    console.log(`Copying SSH keys to ${agentUserSshDir}...`);

    const reason = "required to copy SSH keys";

    // Create .ssh dir with proper ownership and permissions
    await runAsAgentUser(
        `mkdir -p ${agentUserSshDir} && chmod 700 ${agentUserSshDir}`
    );

    // Copy keys as root (agent user can't read the source), then chown to agent user
    await askSudoPasswordAndRun(
        `cp ${privateKey} ${agentUserSshDir}/id_rsa && chown ${AGENT_USER} ${agentUserSshDir}/id_rsa && chmod 600 ${agentUserSshDir}/id_rsa`,
        reason
    );
    await askSudoPasswordAndRun(
        `cp ${publicKey} ${agentUserSshDir}/id_rsa.pub && chown ${AGENT_USER} ${agentUserSshDir}/id_rsa.pub && chmod 644 ${agentUserSshDir}/id_rsa.pub`,
        reason
    );

    // Add GitHub's host key to known_hosts to avoid interactive prompt
    await runAsAgentUser(
        `ssh-keyscan -t rsa github.com >> ${agentUserSshDir}/known_hosts`
    );
    console.log(
        "SSH keys copied, permissions set, and GitHub added to known_hosts."
    );
}

type GitIdentity = { name: string; email: string };

/**
 * Parse and resolve the git identity early (before any system changes).
 * This validates the --git argument and, if no explicit identity is given,
 * reads the current user's git config.
 */
async function resolveGitIdentity(
    identity: Option<string>
): Promise<GitIdentity> {
    let name: Option<string> = Nothing;
    let email: Option<string> = Nothing;

    if (identity instanceof Some) {
        const match = identity.value.match(/^(.*) <([^>]+)>$/);
        if (match) {
            name = new Some(match[1].trim());
            email = new Some(match[2].trim());
        } else {
            console.error(
                'Invalid format for --git (-g) argument. Expected: "Name Surname <email@example.com>"'
            );
            process.exit(1);
        }
    } else {
        // No identity supplied, copy from current user's git config.
        // git config exits with non-zero when a key is not set, so each
        // call is wrapped in its own try/catch.
        try {
            const nameCmdResult = await execAsync(
                "git config --global user.name"
            );
            if (!TypeHelpers.isNullOrUndefined(nameCmdResult.stdout)) {
                let trimmedName = nameCmdResult.stdout.trim();
                if (trimmedName !== Empty.string()) {
                    name = new Some(trimmedName);
                }
            }
        } catch {
            // user.name not set in current user's git config
        }
        try {
            const emailCmdResult = await execAsync(
                "git config --global user.email"
            );
            if (!TypeHelpers.isNullOrUndefined(emailCmdResult.stdout)) {
                let trimmedEmail = emailCmdResult.stdout.trim();
                if (trimmedEmail !== Empty.string()) {
                    email = new Some(trimmedEmail);
                }
            }
        } catch {
            // user.email not set in current user's git config
        }
    }

    if (name instanceof None || email instanceof None) {
        console.error(
            "Could not determine git name and/or email. " +
                "Either set them in your global git config (git config --global user.name / user.email) " +
                'or pass an explicit identity: --git "Name Surname <email@example.com>"'
        );
        process.exit(1);
    }

    return { name: name.value, email: email.value };
}

async function applyGitIdentity(identity: GitIdentity): Promise<void> {
    await runAsAgentUser(
        `git config --global user.name "${identity.name}" && git config --global user.email "${identity.email}"`
    );
    console.log(
        `Git config for '${AGENT_USER}' set to ${identity.name} <${identity.email}>`
    );
}

async function wipeInstallation(): Promise<void> {
    const installDir = getPiInstallDir();
    if (fs.existsSync(installDir)) {
        console.log(`Wiping existing installation at ${installDir}...`);
        await runAsAgentUser(`rm -rf ${installDir}`);
        console.log("Installation wiped.");
    } else {
        console.log("No existing installation found, nothing to wipe.");
    }
}

async function destroyInstallation(): Promise<void> {
    console.log("\n=== DESTROY MODE ===");
    console.log("This will permanently DELETE:");
    console.log(`  - The '${AGENT_USER}' user`);
    console.log(
        `  - All data in ${agentUserHome} (the user\'s home directory)`
    );
    console.log(`  - The '${AGENT_GROUP_NAME}' group`);
    console.log(`  - The launcher script ~/bin/${LAUNCHER_SCRIPT_FILENAME}`);
    console.log(
        `  - The launcher script ~/bin/${CONTEXT_LENS_SCRIPT_FILENAME}`
    );
    console.log("");

    const confirmation = await askQuestion(
        'Are you absolutely sure? Type "DELETE" to confirm: '
    );
    if (confirmation.trim() !== "DELETE") {
        console.log("Aborted. Nothing was deleted.");
        return;
    }

    const reason = "required to destroy installation";

    // Delete the user first (which also removes the home directory on Linux with -r, and on macOS sysadminctl removes the home)
    console.log(`Deleting user '${AGENT_USER}'...`);
    if (await userExists(AGENT_USER)) {
        if (CURRENT_OS === UnixBasedOS.MacOS) {
            // sysadminctl deletes the user and its home directory by default
            await askSudoPasswordAndRun(
                `sysadminctl -deleteUser ${AGENT_USER}`,
                reason
            );
        } else {
            // -r flag removes the home directory
            await askSudoPasswordAndRun(`userdel -r ${AGENT_USER}`, reason);
        }
        console.log(`User '${AGENT_USER}' deleted.`);
    } else {
        console.log(
            `User '${AGENT_USER}' does not exist, skipping (already deleted or not created yet).`
        );
    }

    // Ensure home directory is gone (some macOS configs may leave it)
    if (fs.existsSync(agentUserHome)) {
        console.log(`Cleaning residual home directory ${agentUserHome}...`);
        await askSudoPasswordAndRun(`rm -rf ${agentUserHome}`, reason);
        console.log("Residual home directory removed.");
    }

    // Delete the group
    console.log(`Deleting group '${AGENT_GROUP_NAME}'...`);
    if (await groupExists(AGENT_GROUP_NAME)) {
        if (CURRENT_OS === UnixBasedOS.MacOS) {
            await askSudoPasswordAndRun(
                `dscl . -delete /Groups/${AGENT_GROUP_NAME}`,
                reason
            );
        } else {
            await askSudoPasswordAndRun(`groupdel ${AGENT_GROUP_NAME}`, reason);
        }
        console.log(`Group '${AGENT_GROUP_NAME}' deleted.`);
    } else {
        console.log(
            `Group '${AGENT_GROUP_NAME}' does not exist, skipping (already deleted or not created yet).`
        );
    }

    // Remove the launcher scripts
    for (const scriptFileName of [
        LAUNCHER_SCRIPT_FILENAME,
        CONTEXT_LENS_SCRIPT_FILENAME,
    ]) {
        const launcherPath = path.join(os.homedir(), "bin", scriptFileName);
        if (fs.existsSync(launcherPath)) {
            console.log(`Removing launcher script at ${launcherPath}...`);
            fs.unlinkSync(launcherPath);
            console.log("Launcher script removed.");
        }
    }

    console.log("\n=== DESTROY COMPLETE ===");
    console.log("All related resources have been removed.");
}

async function main() {
    const program = new Command();
    program
        .version(pkg.version, "-V, --version", "Output the version number.")
        .description(pkg.description)
        .helpOption("-h, --help", "Show this help message.")
        .option(
            "-v, --verbose",
            "Show detailed output from install commands (useful for slow connections or debugging skynot)."
        )
        .option(
            "-u, --update",
            `Wipe and reinstall Pi, to get the latest version (everything else should remain intact, e.g. Pi's extensions/settings/sessions/... which live in ${AGENT_USER}'s $HOME/.pi/agent/ directory, etc.).`
        )
        .option(
            "-e, --extensions",
            `DEPRECATED: rather use \`${LAUNCHER_SCRIPT_FILENAME} install <extension>\` instead, after install.`
        )
        .option(
            "-c, --context-lens",
            `This flag additionaly installs context-lens after installing Pi and creates a launcher script "cpi" for it.`
        )
        .option(
            "-a, --auth",
            `Prompt for AI model's credentials to add env var to launcher script, or to create an auth.json file.`
        )
        .option("-n, --npm", `Install Pi using npm instead of tarball.`)
        .option(
            "-s, --ssh",
            `Copy current user's SSH keys to the '${AGENT_USER}' user for git SSH access (and add GitHub to known_hosts).`
        )
        .option(
            "-g, --git [identity]",
            `Configure git user.name and user.email for the '${AGENT_USER}' user. If no argument is given, copies from current user's git config. If an argument is supplied (e.g. "Name Surname <user@example.com>"), uses that instead.`
        )
        .option(
            "-p, --paranoid",
            `Refrain from caching the sudo password; ask for it every time it is needed.`
        )
        .option(
            "--BURN, --destroy",
            `Destroy the '${AGENT_USER}' user, their home directory (${agentUserHome}), and the '${AGENT_GROUP_NAME}' group. Requires interactive user confirmation.`
        );
    program.parse(process.argv);
    const opts = program.opts();

    // Requirement checks (placed after parse so --help/--version still work)
    const minGitVersionStr = `v${MIN_GIT_VERSION[0]}.${MIN_GIT_VERSION[1]}`;
    try {
        const gitVersionResult = await execAsync("git --version");
        const gitVersionMatch = gitVersionResult.stdout
            .trim()
            .match(/git version (\d+)\.(\d+)/);
        if (!gitVersionMatch) {
            console.error(
                `Error: could not determine git version. Please install git ${minGitVersionStr} or newer.`
            );
            process.exit(1);
        }
        const gitMajor = parseInt(gitVersionMatch[1], 10);
        const gitMinor = parseInt(gitVersionMatch[2], 10);
        if (
            gitMajor < MIN_GIT_VERSION[0] ||
            (gitMajor === MIN_GIT_VERSION[0] && gitMinor < MIN_GIT_VERSION[1])
        ) {
            console.error(
                `Error: git version ${gitMajor}.${gitMinor} is too old. Please install git ${minGitVersionStr} or newer (required for wildcard support in git config).`
            );
            process.exit(1);
        }
    } catch (err: unknown) {
        if (
            err instanceof Error &&
            (err.message.includes("not found") ||
                err.message.includes("No such file"))
        ) {
            console.error(
                `Error: git not found. Please install git ${minGitVersionStr} or newer.`
            );
        } else {
            console.error(
                `Error: could not run git. Please install git ${minGitVersionStr} or newer.`
            );
        }
        process.exit(1);
    }
    try {
        await execAsync("which npm");
    } catch {
        console.error("Error: npm not found. Please install npm.");
        process.exit(1);
    }
    if (CURRENT_OS !== UnixBasedOS.MacOS) {
        try {
            await execAsync("which setfacl");
        } catch {
            console.error(
                "Error: setfacl not found. Please install it (e.g., 'apt install acl' on Debian/Ubuntu)."
            );
            process.exit(1);
        }
    }
    await checkNodeVersion("current user");

    if (opts.paranoid) {
        paranoidMode = true;
    }

    // Parse and validate --git argument early, before any system changes
    let resolvedGitIdentity: Option<GitIdentity> = Nothing;
    if (opts.git) {
        let identity: Option<string>;
        if (opts.git === true) {
            identity = Nothing;
        } else if (typeof opts.git === "string") {
            identity = new Some(opts.git);
        } else {
            console.error(
                'Invalid --git argument. Expected a string in the form "Name Surname <email@example.com>" or no argument at all.'
            );
            process.exit(1);
        }
        resolvedGitIdentity = new Some(await resolveGitIdentity(identity));
    }

    if (opts.destroy) {
        if (opts.update || opts.extensions || opts.auth || opts.ssh) {
            console.error(
                "Error: --destroy is only compatible with --verbose and/or --paranoid flags)"
            );
            console.error(
                "Please try again with a different flags combination."
            );
            process.exit(1);
        }
        await destroyInstallation();
        return;
    }

    // wget is needed to download tarball
    if (!opts.npm) {
        await checkWget();
    }
    // mitmproxy is needed for context-lens
    if (opts.contextLens) {
        await checkMitmProxy();
    }

    await ensureAgentGroupExists();
    await ensureAgentUserExists();

    // Verify Node version for agent user
    await checkNodeVersion("agent user", `sudo -i -u ${AGENT_USER}`);

    // Ensure both users belong to the agent group, and agent user belongs exclusively to it
    const currentUser = os.userInfo().username;
    await ensureUserInGroup(AGENT_USER);
    await ensureUserInGroup(currentUser);
    await ensureExclusiveGroupMembership(AGENT_USER);

    // Ensure the current user can switch to the agent user without a password
    await addSudoersEntry();

    const installDir = getPiInstallDir();
    let piBinaryPath: string;
    if (opts.npm) {
        if (opts.update) {
            await wipeInstallation();
        }
        await installAgentUsingNpm(opts.verbose);
        piBinaryPath = `${installDir}/node_modules/.bin/pi`;
    } else {
        await installAgentFromTarball(opts.update, opts.verbose);
        piBinaryPath = `${installDir}/pi`;
    }

    if (opts.extensions) {
        await installExtensions(piBinaryPath, opts.verbose);
    }

    if (opts.ssh) {
        await copySshKeys();
    }

    if (resolvedGitIdentity instanceof Some) {
        await applyGitIdentity(resolvedGitIdentity.value);
    }

    await updatePath();
    await updateAgentUserUmask();
    await setupUmaskScriptForCurrentUser();

    let apiKeyExport: Option<{ name: string; value: string }> = Nothing;
    if (opts.auth) {
        apiKeyExport = await configureAuth();
    }

    await createPiLauncherScript(piBinaryPath, apiKeyExport);

    if (opts.contextLens) {
        await installContextLens(opts.update, apiKeyExport, opts.verbose);
    }

    const workDir = await setupWorkDir();
    console.log(
        `\nPi is ready to be launched with '${LAUNCHER_SCRIPT_FILENAME}' command.`
    );
    console.log(`\nRECOMMENDED next steps:`);
    console.log(
        `1. IMPORTANT: Log out of the system and log in again (for group permissions to take effect, $PATH env var to be updated, etc.)`
    );
    console.log(`2. \`cd\` into '${workDir}'`);
    console.log(`3. Clone the git repository where you will work on`);
    console.log(`4. \`cd\` into the cloned repository`);
    console.log(`5. Launch via \`${LAUNCHER_SCRIPT_FILENAME}\`\n`);
    if (opts.contextLens) {
        console.log(
            `6. Launch with context-lens via \`${CONTEXT_LENS_SCRIPT_FILENAME}\`\n`
        );
    }
}

main().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
});

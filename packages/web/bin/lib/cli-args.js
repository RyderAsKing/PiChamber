import { TunnelCliError, EXIT_CODE } from './cli-errors.js';

const DEFAULT_PORT = 3000;
const DEFAULT_TAIL_LINES = 200;

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function findClosestMatch(input, candidates, maxDistance = 3) {
  if (typeof input !== 'string' || input.length === 0 || !Array.isArray(candidates)) {
    return null;
  }
  const normalized = input.toLowerCase();
  let bestCandidate = null;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const distance = levenshteinDistance(normalized, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCandidate = candidate;
    }
  }
  return bestDistance <= maxDistance ? bestCandidate : null;
}

function splitOptionToken(arg) {
  if (!arg.startsWith('-')) return null;
  if (arg.startsWith('--')) {
    const eqIndex = arg.indexOf('=');
    return {
      name: eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2),
      inlineValue: eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined,
      long: true,
    };
  }
  return {
    name: arg.slice(1),
    inlineValue: undefined,
    long: false,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const options = {
    port: DEFAULT_PORT,
    host: undefined,
    uiPassword: process.env.PICHAMBER_UI_PASSWORD || process.env.PICHAMBER_UI_PASSWORD || undefined,
    json: false,
    all: false,
    follow: true,
    lines: DEFAULT_TAIL_LINES,
    limit: undefined,
    provider: undefined,
    mode: undefined,
    profile: undefined,
    name: undefined,
    title: undefined,
    configPath: undefined,
    token: undefined,
    tokenFile: undefined,
    tokenStdin: false,
    hostname: undefined,
    server: undefined,
    connectTtl: undefined,
    sessionTtl: undefined,
    qr: false,
    explicitQr: false,
    force: false,
    showSecrets: false,
    dryRun: false,
    plain: false,
    quiet: false,
    explicitPort: false,
    explicitUiPassword: false,
    envSnapshot: true,
    foreground: false,
    lan: false,
    apiOnly: false,
    project: undefined,
    session: undefined,
    message: undefined,
    prompt: undefined,
    model: undefined,
    agent: undefined,
    variant: undefined,
    directory: undefined,
    role: undefined,
    last: false,
    wait: false,
    timeout: undefined,
    lastAssistant: false,
    withStatus: false,
    yes: false,
  };

  const removedFlagErrors = [];
  const positional = [];
  let helpRequested = false;
  let versionRequested = false;

  const consumeValue = (index, inlineValue) => {
    if (typeof inlineValue === 'string' && inlineValue.length > 0) {
      return { value: inlineValue, nextIndex: index };
    }
    const candidate = args[index + 1];
    if (typeof candidate === 'string' && !candidate.startsWith('-')) {
      return { value: candidate, nextIndex: index + 1 };
    }
    return { value: undefined, nextIndex: index };
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const parsedToken = splitOptionToken(arg);
    if (!parsedToken) {
      positional.push(arg);
      continue;
    }

    const { name, inlineValue, long } = parsedToken;
    switch (name) {
      case 'port':
      case 'p': {
        const { value: consumedValue, nextIndex: consumedIndex } = consumeValue(i, inlineValue);
        let value = consumedValue;
        let nextIndex = consumedIndex;

        // Support explicit negative numeric values like `-p -1` so we can report
        // a clear range validation error instead of "Unknown option".
        if (value === undefined && typeof inlineValue !== 'string') {
          const candidate = args[i + 1];
          if (typeof candidate === 'string' && /^-\d+$/.test(candidate)) {
            value = candidate;
            nextIndex = i + 1;
          }
        }

        i = nextIndex;

        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new TunnelCliError('Missing value for --port.', EXIT_CODE.USAGE_ERROR);
        }

        if (!/^-?\d+$/.test(value.trim())) {
          throw new TunnelCliError(`Invalid port value: ${value}`, EXIT_CODE.USAGE_ERROR);
        }

        const parsed = parseInt(value, 10);
        if (parsed < 1 || parsed > 65535) {
          throw new TunnelCliError(`Invalid port value: ${parsed}`, EXIT_CODE.USAGE_ERROR);
        }

        options.port = parsed;
        options.explicitPort = true;
        break;
      }
      case 'host': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new TunnelCliError('Missing value for --host.', EXIT_CODE.USAGE_ERROR);
        }
        options.host = value.trim();
        break;
      }
      case 'lan':
        options.lan = true;
        break;
      case 'ui-password': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.uiPassword = typeof value === 'string' ? value : '';
        options.explicitUiPassword = true;
        break;
      }
      case 'provider': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.provider = typeof value === 'string' ? value : options.provider;
        break;
      }
      case 'mode': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.mode = typeof value === 'string' ? value : options.mode;
        break;
      }
      case 'profile': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.profile = typeof value === 'string' ? value : options.profile;
        break;
      }
      case 'name': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.name = typeof value === 'string' ? value : options.name;
        break;
      }
      case 'title': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.title = typeof value === 'string' ? value : options.title;
        break;
      }
      case 'branch': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.branch = typeof value === 'string' ? value : options.branch;
        break;
      }
      case 'start-ref':
      case 'base': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.startRef = typeof value === 'string' ? value : options.startRef;
        break;
      }
      case 'upstream':
        options.setUpstream = true;
        break;
      case 'no-upstream':
        options.setUpstream = false;
        break;
      case 'project': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.project = typeof value === 'string' ? value : options.project;
        break;
      }
      case 'dir':
      case 'directory': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.directory = typeof value === 'string' ? value : options.directory;
        break;
      }
      case 'session': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.session = typeof value === 'string' ? value : options.session;
        break;
      }
      case 'message': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.message = typeof value === 'string' ? value : options.message;
        break;
      }
      case 'prompt': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.prompt = typeof value === 'string' ? value : options.prompt;
        break;
      }
      case 'model': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.model = typeof value === 'string' ? value : options.model;
        break;
      }
      case 'config': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.configPath = typeof value === 'string' ? value : null;
        break;
      }
      case 'token': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.token = typeof value === 'string' ? value : options.token;
        break;
      }
      case 'token-file': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.tokenFile = typeof value === 'string' ? value : options.tokenFile;
        break;
      }
      case 'token-stdin':
        options.tokenStdin = true;
        break;
      case 'hostname': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.hostname = typeof value === 'string' ? value : options.hostname;
        break;
      }
      case 'server':
      case 'server-url': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new TunnelCliError('Missing value for --server.', EXIT_CODE.USAGE_ERROR);
        }
        options.server = value.trim();
        break;
      }
      case 'connect-ttl': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.connectTtl = typeof value === 'string' ? value : options.connectTtl;
        break;
      }
      case 'session-ttl': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.sessionTtl = typeof value === 'string' ? value : options.sessionTtl;
        break;
      }
      case 'json':
        options.json = true;
        break;
      case 'all':
        options.all = true;
        break;
      case 'last':
        options.last = true;
        break;
      case 'last-assistant':
        options.lastAssistant = true;
        break;
      case 'wait':
        options.wait = true;
        break;
      case 'timeout': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.timeout = typeof value === 'string' ? value : options.timeout;
        break;
      }
      case 'with-status':
        options.withStatus = true;
        break;
      case 'role': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.role = typeof value === 'string' ? value : options.role;
        break;
      }
      case 'no-follow':
        options.follow = false;
        break;
      case 'no-env-snapshot':
        options.envSnapshot = false;
        break;
      case 'lines': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        const parsed = parseInt(value ?? '', 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          options.lines = parsed;
        }
        break;
      }
      case 'limit': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        const parsed = parseInt(value ?? '', 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new TunnelCliError('Invalid limit value. Provide a positive integer.', EXIT_CODE.USAGE_ERROR);
        }
        options.limit = parsed;
        break;
      }
      case 'relay':
        options.relay = true;
        break;
      case 'qr':
        options.qr = true;
        options.explicitQr = true;
        break;
      case 'no-qr':
        options.qr = false;
        options.explicitQr = true;
        break;
      case 'force':
        options.force = true;
        break;
      case 'show-secrets':
        options.showSecrets = true;
        break;
      case 'dry-run':
        options.dryRun = true;
        break;
      case 'plain':
        options.plain = true;
        break;
      case 'quiet':
      case 'q':
        options.quiet = true;
        break;
      case 'yes':
      case 'y':
        options.yes = true;
        break;
      case 'help':
      case 'h':
        helpRequested = true;
        break;
      case 'version':
      case 'v':
        versionRequested = true;
        break;
      case 'foreground':
      case 'no-daemon':
        options.foreground = true;
        break;
      case 'api-only':
        options.apiOnly = true;
        break;
      case 'daemon':
      case 'd':
        // Legacy no-op: daemon mode is already the default, but older clients
        // may still pass this when starting a remote server.
        break;
      case 'try-cf-tunnel':
        removedFlagErrors.push('`--try-cf-tunnel` was removed. Use: pichamber tunnel start --provider cloudflare --mode quick');
        break;
      case 'tunnel-qr':
        removedFlagErrors.push('`--tunnel-qr` was removed. Use: pichamber tunnel start ... --qr');
        break;
      case 'tunnel-password-url':
        removedFlagErrors.push('`--tunnel-password-url` was removed. Use UI password auth directly after tunnel start.');
        break;
      case 'tunnel-provider':
      case 'tunnel-mode':
      case 'tunnel-config':
      case 'tunnel-token':
      case 'tunnel-hostname':
      case 'tunnel':
        removedFlagErrors.push(`\`--${name}\` was removed from top-level serve flow. Use: pichamber tunnel start ...`);
        break;
      default:
        if (!long && name.length === 1) {
          removedFlagErrors.push(`Unknown option: -${name}`);
        } else {
          removedFlagErrors.push(`Unknown option: --${name}`);
        }
        break;
    }
  }

  const explicitCommand = positional.length > 0;
  const command = positional[0] || 'serve';
  const subcommand = command === 'tunnel' ? (positional[1] || 'help') : null;
  const tunnelAction = command === 'tunnel' ? (positional[2] || null) : null;
  const startupAction = command === 'startup' ? (positional[1] || 'status') : null;

  if (options.lan && typeof options.host !== 'string') {
    options.host = '0.0.0.0';
  }

  if (command !== 'tunnel' && typeof options.hostname === 'string' && typeof options.host !== 'string') {
    options.host = options.hostname;
  }

  return {
    command,
    explicitCommand,
    subcommand,
    tunnelAction,
    startupAction,
    options,
    removedFlagErrors,
    helpRequested,
    versionRequested,
  };
}

function showHelp() {
  console.log(`
 PiChamber - Web interface for the Pi coding agent

USAGE:
  pichamber [COMMAND] [OPTIONS]

COMMANDS:
  serve          Configure and start the web server (guided in interactive terminals)
  stop           Stop running instance(s)
  restart        Stop and start the server
  status         Show server status
  tunnel         Tunnel lifecycle commands
  startup        Manage launch at system startup
  logs           Tail PiChamber logs
  connect-url    Generate URL/QR for connecting another client
  update         Check for and install updates
  version        Show the installed PiChamber version

OPTIONS:
  -p, --port              Web server port (default: ${DEFAULT_PORT})
  --host                  Bind address (default: 127.0.0.1)
  --hostname              Alias for --host outside tunnel commands
  --lan                   Bind to 0.0.0.0 for LAN access
  --server <url>          Public/server URL for connect-url links
  --relay                 connect-url: also include the end-to-end-encrypted relay transport
  --ui-password [password] Protect browser UI with a password (generates one when omitted)
  --api-only              Start API routes only, without serving browser UI assets
  --foreground            Run server in foreground (use with systemd/process managers)
  --no-daemon             Alias for --foreground
  -y, --yes               Confirm update without prompting
  -h, --help              Show help
  -v, --version           Show version

ENVIRONMENT:
  PICHAMBER_HOST               Bind address (e.g. 0.0.0.0 for all interfaces)
  PICHAMBER_UI_PASSWORD        Alternative to --ui-password flag
  PICHAMBER_API_ONLY           Set to true/1 to start API routes only
  PICHAMBER_DATA_DIR           Override PiChamber data directory

  (Legacy PICHAMBER_* spellings are still honored.)

EXAMPLES:
  pichamber                    # Start in daemon mode on default port 3000 (or free port)
  pichamber --port 8080        # Start on port 8080 (daemon)
  pichamber --lan --port 3002  # Start on LAN at 0.0.0.0:3002
  pichamber serve              # Walk through interactive server setup
  pichamber serve --foreground # Start in foreground without setup prompts
  pichamber connect-url --port 3000 --qr
  pichamber connect-url --server https://pichamber.example.com
  pichamber startup enable --lan --port 3002 --ui-password
                               # Login service on LAN at 0.0.0.0:3002
  pichamber tunnel help        # Show tunnel lifecycle help
  pichamber logs               # Follow logs for latest running instance
  pichamber version            # Show the installed version
`);
}

function showStartupHelp() {
  console.log(`
 PiChamber Startup Commands

USAGE:
  pichamber startup <SUBCOMMAND> [OPTIONS]

DESCRIPTION:
  Installs a native startup service that runs pichamber serve --foreground.
  In an interactive terminal, enable walks through access, port, and password
  setup. Supplied flags keep the command non-interactive. Re-run enable to
  replace the stored command.

SUBCOMMANDS:
  status      Show startup integration status
  enable      Configure, install, and start native startup integration
  disable     Stop and remove native startup integration

ENABLE FLAGS:
  These become the serve command the login service runs.

  -p, --port <port>       Listen port (default: ${DEFAULT_PORT})
  --host <address>        Bind address (default: 127.0.0.1, this machine only)
  --hostname <address>    Alias for --host
  --lan                   Same as --host 0.0.0.0 — reachable on your LAN/Wi-Fi
  --ui-password [secret]  Required with --lan (omit the value to generate one)
  --api-only              API routes only, no browser UI
  --no-env-snapshot       Do not copy the current shell environment
  --json                  Machine-readable JSON
  -q, --quiet             Suppress non-essential output

LAN ACCESS:
  Other devices on the same network need --lan and a UI password:

    pichamber startup enable --lan --port 3002 --ui-password

  Then open http://<this-computer-lan-ip>:3002 on those devices.

EXAMPLES:
  pichamber startup enable
      This machine only, port ${DEFAULT_PORT}

  pichamber startup enable --port 8080
      This machine only, port 8080

  pichamber startup enable --lan --port 3002 --ui-password
      LAN/Wi-Fi on port 3002 (password generated if omitted)

  pichamber startup enable --host 0.0.0.0 --port 3002 --ui-password secret
      Same as --lan, with an explicit password

  pichamber startup status
  pichamber startup disable
`);
}

function showConnectUrlHelp() {
  console.log(`
 PiChamber Connect URL

USAGE:
  pichamber connect-url [OPTIONS]

DESCRIPTION:
  Generate an pichamber:// connection link for adding this server to another
  PiChamber app. If no server is running on the selected port, it starts one.

OPTIONS:
  -p, --port <port>       Server port to use or start (default: ${DEFAULT_PORT})
  --host <address>        Bind address when starting the server
  --hostname <address>    Alias for --host
  --lan                   Bind to 0.0.0.0 for LAN access when starting
  --server <url>          Public URL saved into the connection link
  --server-url <url>      Alias for --server
  --relay                 Also include the end-to-end-encrypted relay transport
                          so the link works away from the local network. The
                          device prefers the direct connection when reachable;
                          the instance brings the relay up on its own. Set
                          PICHAMBER_RELAY_URL to use a self-hosted relay.
  --name <label>          Label saved with the remote client token
  --ui-password <value>   Protect browser access when UI routes are enabled
  --api-only              Start in headless/API-only mode when starting
  --qr                    Print a QR code for the connection link
  --json                  Output machine-readable JSON
  -q, --quiet             Print only the connection link
  -h, --help              Show this help

EXAMPLES:
  pichamber connect-url --port 3000 --qr
  pichamber connect-url --port 3000 --api-only --lan --server http://workstation.local:3000 --qr
  pichamber connect-url --server https://pichamber.example.com --name Workstation
  pichamber connect-url --relay --name "My laptop"
`);
}

function showTunnelHelp() {
  console.log(`
 Tunnel Lifecycle Commands

USAGE:
  pichamber tunnel <SUBCOMMAND> [OPTIONS]

SUBCOMMANDS:
  help        Show this tunnel help
  providers   Show available tunnel providers and capabilities
  ready       Check tunnel readiness for a provider
  doctor      Run deep tunnel diagnostics
  status      Show tunnel status
  start       Start a tunnel
  stop        Stop active tunnel (keep server running)
  profile     Manage saved managed-remote profiles

COMMON OPTIONS:
  -p, --port              Target PiChamber instance port
  --host                  Bind address when auto-starting an instance
  --lan                   Bind to 0.0.0.0 when auto-starting an instance
  --ui-password [password] Protect browser UI when auto-starting an instance (generates one when omitted)
  --api-only              Start API routes only when auto-starting an instance
  --json                  Output machine-readable JSON
  --all                   Apply to all running instances (doctor default, stop)

START OPTIONS:
  --provider <id>         Tunnel provider id (default: cloudflare)
  --mode <id>             Tunnel mode (default: quick)
  --profile <name>        Start tunnel from saved profile name
  --config [path]         Managed-local config path (optional)
  --token <token>         Managed-remote token (visible in process list)
  --token-file <path>     Read token from file (recommended)
  --token-stdin           Read token from stdin
  --hostname <hostname>   Managed-remote hostname
  --connect-ttl <value>   Connect-link TTL (e.g. 30m, 24h, 1d)
  --session-ttl <value>   Session TTL (e.g. 8h, 24h, 1d)
  --qr                    Print QR code for resulting tunnel URL
  --no-qr                 Disable QR output
  --dry-run               Validate inputs without applying changes

OUTPUT OPTIONS:
  --show-secrets          Show full tokens in output (default: redacted)
  --plain                 Disable colors and decorations
  -q, --quiet             Suppress non-essential output
  --json                  Output machine-readable JSON

BEHAVIOR NOTES:
  - One active tunnel per PiChamber instance.
  - Starting a different mode/provider replaces the current tunnel and revokes old connect links/sessions.
  - Connect links are one-time; generating a new link revokes the previous unused link.

PROFILE USAGE:
  pichamber tunnel profile list [--provider <id>] [--json]
  pichamber tunnel profile show --name <name> [--provider <id>] [--json]
  pichamber tunnel profile add --provider <id> --mode managed-remote --name <name> --hostname <host> --token <token> [--force] [--json]
  pichamber tunnel profile add --provider <id> --mode managed-remote --name <name> --hostname <host> --token-file <path> [--force] [--json]
  pichamber tunnel profile remove --name <name> [--provider <id>] [--json]

SHELL COMPLETION:
  pichamber tunnel completion bash   Generate Bash completion script
  pichamber tunnel completion zsh    Generate Zsh completion script
  pichamber tunnel completion fish   Generate Fish completion script

EXAMPLES:
  pichamber tunnel providers
  pichamber tunnel ready --provider cloudflare
  pichamber tunnel doctor --provider cloudflare
  pichamber tunnel status
  pichamber tunnel start --qr
  pichamber tunnel start --profile prod-main
  pichamber tunnel start --provider cloudflare --mode managed-remote --token-file ~/.secrets/cf-token --hostname app.example.com
  pichamber tunnel start --provider cloudflare --mode managed-local --config ~/.cloudflared/config.yml
  pichamber tunnel start --dry-run --provider cloudflare --mode managed-remote --token-file ~/.secrets/cf-token --hostname app.example.com
  echo "$TOKEN" | pichamber tunnel profile add --provider cloudflare --mode managed-remote --name prod-main --hostname app.example.com --token-stdin
  pichamber tunnel profile list --provider cloudflare
  pichamber tunnel profile list --json --show-secrets
  pichamber tunnel stop --port 3000
`);
}

function generateCompletionScript(shell) {
  const normalized = typeof shell === 'string' ? shell.trim().toLowerCase() : '';

  if (normalized === 'bash') {
    return `# Bash completion for pichamber tunnel
# Add to ~/.bashrc: eval "$(pichamber tunnel completion bash)"
_pichamber_tunnel() {
  local cur prev commands tunnel_commands profile_commands common_flags start_flags
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="serve stop restart status tunnel startup logs connect-url update version"
  tunnel_commands="help providers ready doctor status start stop profile completion"
  profile_commands="list show add remove"
  common_flags="--port --host --lan --ui-password --api-only --foreground --no-daemon --json --all --help --version --plain --quiet --yes"
  start_flags="--provider --mode --profile --config --token --token-file --token-stdin --hostname --connect-ttl --session-ttl --qr --no-qr --dry-run --show-secrets"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return 0
  fi

  if [[ "\${COMP_WORDS[1]}" == "tunnel" ]]; then
    if [[ \${COMP_CWORD} -eq 2 ]]; then
      COMPREPLY=( $(compgen -W "\${tunnel_commands}" -- "\${cur}") )
      return 0
    fi
    if [[ "\${COMP_WORDS[2]}" == "profile" && \${COMP_CWORD} -eq 3 ]]; then
      COMPREPLY=( $(compgen -W "\${profile_commands}" -- "\${cur}") )
      return 0
    fi
    if [[ "\${COMP_WORDS[2]}" == "completion" && \${COMP_CWORD} -eq 3 ]]; then
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") )
      return 0
    fi
    if [[ "\${COMP_WORDS[2]}" == "start" ]]; then
      COMPREPLY=( $(compgen -W "\${start_flags} \${common_flags}" -- "\${cur}") )
      return 0
    fi
    COMPREPLY=( $(compgen -W "\${common_flags}" -- "\${cur}") )
    return 0
  fi

  COMPREPLY=( $(compgen -W "\${common_flags}" -- "\${cur}") )
  return 0
}
complete -F _pichamber_tunnel pichamber
`;
  }

  if (normalized === 'zsh') {
    return `#compdef pichamber
# Zsh completion for pichamber tunnel
# Add to ~/.zshrc: eval "$(pichamber tunnel completion zsh)"

_pichamber() {
  local -a commands tunnel_commands profile_commands

  commands=(
    'serve:Start the web server'
    'stop:Stop running instance(s)'
    'restart:Stop and start the server'
    'status:Show server status'
    'tunnel:Tunnel lifecycle commands'
    'startup:Manage launch at system startup'
    'logs:Tail PiChamber logs'
    'connect-url:Generate a client pairing URL'
    'update:Check for and install updates'
    'version:Show the installed version'
  )

  tunnel_commands=(
    'help:Show tunnel help'
    'providers:Show available providers'
    'ready:Check tunnel readiness'
    'doctor:Run tunnel diagnostics'
    'status:Show tunnel status'
    'start:Start a tunnel'
    'stop:Stop active tunnel'
    'profile:Manage saved profiles'
    'completion:Generate shell completion'
  )

  profile_commands=(
    'list:List profiles'
    'show:Show profile details'
    'add:Add a profile'
    'remove:Remove a profile'
  )

  _arguments -C \\
    '1:command:->command' \\
    '*::arg:->args'

  case \$state in
    command)
      _describe 'command' commands
      ;;
    args)
      case \$words[1] in
        tunnel)
          if (( CURRENT == 2 )); then
            _describe 'tunnel command' tunnel_commands
          elif [[ \$words[2] == "profile" ]] && (( CURRENT == 3 )); then
            _describe 'profile action' profile_commands
          elif [[ \$words[2] == "completion" ]] && (( CURRENT == 3 )); then
            _values 'shell' bash zsh fish
          fi
          ;;
      esac
      ;;
  esac
}

compdef _pichamber pichamber
`;
  }

  if (normalized === 'fish') {
    return `# Fish completion for pichamber tunnel
# Save to ~/.config/fish/completions/pichamber.fish

complete -c pichamber -n '__fish_use_subcommand' -a 'serve' -d 'Start the web server'
complete -c pichamber -n '__fish_seen_subcommand_from serve' -l foreground -d 'Run in foreground (for systemd/process managers)'
complete -c pichamber -n '__fish_seen_subcommand_from serve' -l no-daemon -d 'Run in foreground (alias for --foreground)'
complete -c pichamber -n '__fish_use_subcommand' -a 'stop' -d 'Stop running instance(s)'
complete -c pichamber -n '__fish_use_subcommand' -a 'restart' -d 'Stop and start the server'
complete -c pichamber -n '__fish_use_subcommand' -a 'status' -d 'Show server status'
complete -c pichamber -n '__fish_use_subcommand' -a 'tunnel' -d 'Tunnel lifecycle commands'
complete -c pichamber -n '__fish_use_subcommand' -a 'startup' -d 'Manage launch at system startup'
complete -c pichamber -n '__fish_use_subcommand' -a 'logs' -d 'Tail logs'
complete -c pichamber -n '__fish_use_subcommand' -a 'connect-url' -d 'Generate a client pairing URL'
complete -c pichamber -n '__fish_use_subcommand' -a 'update' -d 'Check for updates'
complete -c pichamber -n '__fish_use_subcommand' -a 'version' -d 'Show installed version'

complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'help' -d 'Show tunnel help'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'providers' -d 'Show providers'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'ready' -d 'Check readiness'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'doctor' -d 'Run diagnostics'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'status' -d 'Show tunnel status'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'start' -d 'Start a tunnel'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'stop' -d 'Stop tunnel'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'profile' -d 'Manage profiles'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'completion' -d 'Generate completions'

complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l provider -d 'Provider id'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l mode -d 'Tunnel mode'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l profile -d 'Profile name'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l config -d 'Config path'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l token -d 'Token'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l token-file -d 'Token file path'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l token-stdin -d 'Read token from stdin'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l hostname -d 'Hostname'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l dry-run -d 'Validate without applying'
complete -c pichamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l qr -d 'Show QR code'
`;
  }

  return null;
}


export {
  DEFAULT_PORT,
  parseArgs,
  showHelp,
  showStartupHelp,
  showConnectUrlHelp,
  showTunnelHelp,
  generateCompletionScript,
  findClosestMatch,
};

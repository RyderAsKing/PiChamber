export function getLanguageFromExtension(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase();

  // Handle special filenames without extensions
  const filename = filePath.split('/').pop()?.toLowerCase() || '';
  const filenameMap: Record<string, string> = {
    'dockerfile': 'dockerfile',
    'makefile': 'makefile',
    'gnumakefile': 'makefile',
    'cmakelists.txt': 'cmake',
    'gemfile': 'ruby',
    'rakefile': 'ruby',
    'podfile': 'ruby',
    'vagrantfile': 'ruby',
    'guardfile': 'ruby',
    'brewfile': 'ruby',
    'fastfile': 'ruby',
    'appfile': 'ruby',
    'matchfile': 'ruby',
    'pluginfile': 'ruby',
    'scanfile': 'ruby',
    'snapfile': 'ruby',
    '.gitignore': 'text',
    '.gitattributes': 'text',
    '.gitmodules': 'ini',
    '.editorconfig': 'ini',
    '.npmrc': 'ini',
    '.yarnrc': 'yaml',
    '.prettierrc': 'json',
    '.eslintrc': 'json',
    '.babelrc': 'json',
    '.browserslistrc': 'text',
    'tsconfig.json': 'jsonc',
    'jsconfig.json': 'jsonc',
    '.env': 'bash',
    '.env.local': 'bash',
    '.env.development': 'bash',
    '.env.production': 'bash',
    '.env.test': 'bash',
    'procfile': 'yaml',
    'codeowners': 'text',
    // Lock files
    'package-lock.json': 'json',
    'composer.lock': 'json',
    'yarn.lock': 'yaml',
    'pnpm-lock.yaml': 'yaml',
    'cargo.lock': 'toml',
    'poetry.lock': 'toml',
    'gemfile.lock': 'ruby',
    'pubspec.lock': 'yaml',
    'packages.lock.json': 'json',
    'bun.lockb': 'text',
    'bun.lock': 'json',
  };

  if (filenameMap[filename]) {
    return filenameMap[filename];
  }

  const languageMap: Record<string, string> = {
    // JavaScript/TypeScript
    'js': 'javascript',
    'jsx': 'jsx',
    'ts': 'typescript',
    'tsx': 'tsx',
    'mjs': 'javascript',
    'cjs': 'javascript',
    'mts': 'typescript',
    'cts': 'typescript',

    // Web markup/styling
    'html': 'html',
    'htm': 'html',
    'xhtml': 'html',
    'vue': 'html',
    'svelte': 'html',
    'astro': 'html',
    'ejs': 'html',
    'hbs': 'handlebars',
    'handlebars': 'handlebars',
    'mustache': 'handlebars',
    'njk': 'twig',
    'nunjucks': 'twig',
    'twig': 'twig',
    'liquid': 'liquid',
    'css': 'css',
    'scss': 'scss',
    'sass': 'sass',
    'less': 'less',
    'styl': 'stylus',
    'stylus': 'stylus',
    'pcss': 'css',
    'postcss': 'css',

    // Data/config formats
    'json': 'json',
    'jsonc': 'json',
    'json5': 'json',
    'jsonl': 'json',
    'ndjson': 'json',
    'geojson': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'xml': 'xml',
    'xsl': 'xml',
    'xslt': 'xml',
    'xsd': 'xml',
    'dtd': 'xml',
    'plist': 'xml',
    'svg': 'xml',
    'rss': 'xml',
    'atom': 'xml',
    'xaml': 'xml',
    'csproj': 'xml',
    'vbproj': 'xml',
    'fsproj': 'xml',
    'props': 'xml',
    'targets': 'xml',
    'nuspec': 'xml',
    'resx': 'xml',
    'ini': 'ini',
    'cfg': 'ini',
    'conf': 'ini',
    'config': 'ini',
    'properties': 'properties',
    'env': 'bash',
    'csv': 'text',
    'tsv': 'text',

    // Python
    'py': 'python',
    'pyw': 'python',
    'pyx': 'python',
    'pxd': 'python',
    'pxi': 'python',
    'pyi': 'python',
    'gyp': 'python',
    'gypi': 'python',
    'bzl': 'python',

    // Ruby
    'rb': 'ruby',
    'erb': 'erb',
    'rake': 'ruby',
    'gemspec': 'ruby',
    'ru': 'ruby',
    'podspec': 'ruby',
    'thor': 'ruby',
    'jbuilder': 'ruby',
    'rabl': 'ruby',
    'builder': 'ruby',

    // PHP
    'php': 'php',
    'phtml': 'php',
    'php3': 'php',
    'php4': 'php',
    'php5': 'php',
    'php7': 'php',
    'phps': 'php',
    'inc': 'php',
    'blade.php': 'php',

    // Java/JVM
    'java': 'java',
    'kt': 'kotlin',
    'kts': 'kotlin',
    'scala': 'scala',
    'sc': 'scala',
    'groovy': 'groovy',
    'gradle': 'groovy',
    'gvy': 'groovy',
    'gy': 'groovy',
    'gsh': 'groovy',

    // C/C++/Objective-C
    'c': 'c',
    'h': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'c++': 'cpp',
    'hpp': 'cpp',
    'hxx': 'cpp',
    'hh': 'cpp',
    'h++': 'cpp',
    'ino': 'cpp',
    'm': 'objectivec',
    'mm': 'objectivec',

    // C#/F#/.NET
    'cs': 'csharp',
    'csx': 'csharp',
    'cake': 'csharp',
    'fs': 'fsharp',
    'fsx': 'fsharp',
    'fsi': 'fsharp',
    'vb': 'vbnet',

    // Go
    'go': 'go',
    'mod': 'go',
    'sum': 'text',

    // Rust
    'rs': 'rust',

    // Swift
    'swift': 'swift',

    // Dart
    'dart': 'dart',

    // Lua
    'lua': 'lua',

    // Perl
    'pl': 'perl',
    'pm': 'perl',
    'pod': 'perl',
    't': 'perl',

    // R
    'r': 'r',
    'R': 'r',
    'rmd': 'markdown',
    'rnw': 'r',

    // Julia
    'jl': 'julia',

    // Haskell
    'hs': 'haskell',
    'lhs': 'haskell',

    // Elixir/Erlang
    'ex': 'elixir',
    'exs': 'elixir',
    'eex': 'html',
    'heex': 'html',
    'leex': 'html',
    'erl': 'erlang',
    'hrl': 'erlang',

    // Clojure
    'clj': 'clojure',
    'cljs': 'clojure',
    'cljc': 'clojure',
    'edn': 'clojure',

    // Lisp/Scheme
    'lisp': 'lisp',
    'cl': 'lisp',
    'el': 'lisp',
    'scm': 'scheme',
    'ss': 'scheme',
    'rkt': 'scheme',

    // OCaml/ReasonML
    'ml': 'ocaml',
    'mli': 'ocaml',
    're': 'reason',
    'rei': 'reason',

    // Nim
    'nim': 'nim',
    'nims': 'nim',
    'nimble': 'nim',

    // Zig
    'zig': 'zig',

    // V
    'v': 'v',
    'vsh': 'v',

    // Crystal
    'cr': 'crystal',

    // D
    'd': 'd',
    'di': 'd',

    // Shell/Scripts
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    'fish': 'bash',
    'ksh': 'bash',
    'csh': 'bash',
    'tcsh': 'bash',
    'ps1': 'powershell',
    'psm1': 'powershell',
    'psd1': 'powershell',
    'bat': 'batch',
    'cmd': 'batch',

    // SQL
    'sql': 'sql',
    'psql': 'sql',
    'plsql': 'sql',
    'mysql': 'sql',
    'pgsql': 'sql',
    'sqlite': 'sql',

    // GraphQL
    'graphql': 'graphql',
    'gql': 'graphql',

    // Solidity
    'sol': 'solidity',

    // Assembly
    'asm': 'nasm',
    's': 'nasm',
    'S': 'nasm',

    // Nix
    'nix': 'nix',

    // Terraform/HCL
    'tf': 'hcl',
    'tfvars': 'hcl',
    'hcl': 'hcl',

    // Docker
    'dockerignore': 'text',

    // Puppet
    'pp': 'puppet',

    // LaTeX
    'tex': 'latex',
    'latex': 'latex',
    'sty': 'latex',
    'cls': 'latex',
    'bib': 'bibtex',
    'bst': 'bibtex',

    // Markdown/docs
    'md': 'markdown',
    'mdx': 'markdown',
    'markdown': 'markdown',
    'mdown': 'markdown',
    'mkd': 'markdown',
    'rst': 'text',
    'adoc': 'asciidoc',
    'asciidoc': 'asciidoc',
    'org': 'text',
    'txt': 'text',
    'text': 'text',
    'rtf': 'text',

    // Vim
    'vim': 'vim',
    'vimrc': 'vim',

    // Makefile variants
    'mk': 'makefile',

    // CMake
    'cmake': 'cmake',

    // Diff/Patch
    'diff': 'diff',
    'patch': 'diff',

    // Prisma
    'prisma': 'prisma',

    // Protocol Buffers
    'proto': 'protobuf',

    // Thrift
    'thrift': 'thrift',

    // WASM
    'wat': 'wasm',
    'wast': 'wasm',

    // GLSL/Shaders
    'glsl': 'glsl',
    'vert': 'glsl',
    'frag': 'glsl',
    'geom': 'glsl',
    'comp': 'glsl',
    'hlsl': 'hlsl',
    'fx': 'hlsl',
    'cg': 'cg',
    'shader': 'glsl',

    // Apache/Nginx config
    'htaccess': 'apacheconf',
    'nginx': 'nginx',

    // Kubernetes
    'kubeconfig': 'yaml',

    // Ansible
    'ansible': 'yaml',
  };

  return languageMap[ext || ''] || null;
}

const DIAGRAM_EXTENSIONS = ['drawio', 'dio'];

export function isDrawioFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return DIAGRAM_EXTENSIONS.includes(ext || '');
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'];

export function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext || '');
}

export function isPdfFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext === 'pdf';
}

export function isSvgFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.svg');
}

/** Known non-text extensions that must not be opened or saved as UTF-8 text. */
const BINARY_FILE_EXTENSIONS = new Set([
  // Documents / office
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  // Archives / packages
  'zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'jar', 'war', 'apk', 'dmg', 'iso',
  'deb', 'rpm', 'msi',
  // Images (svg is text and is excluded via isSvgFile)
  ...IMAGE_EXTENSIONS.filter((ext) => ext !== 'svg'),
  // Audio / video
  'mp3', 'mp4', 'm4a', 'aac', 'flac', 'ogg', 'wav', 'wma', 'avi', 'mov', 'mkv', 'webm', 'wmv',
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // Native / bytecode
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'o', 'a', 'lib', 'wasm', 'node',
  // Databases / locks / misc binary
  'sqlite', 'sqlite3', 'db', 'dat', 'parquet', 'feather', 'pickle', 'pyc', 'pyo', 'lockb',
]);

export function getFileExtension(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return '';
  }
  return base.slice(dot + 1).toLowerCase();
}

/** True for known binary extensions (including images/PDF). SVG is not binary. */
export function isBinaryFile(filePath: string): boolean {
  if (isSvgFile(filePath)) {
    return false;
  }
  const ext = getFileExtension(filePath);
  return BINARY_FILE_EXTENSIONS.has(ext);
}

/**
 * Heuristic for UTF-8 text that is actually binary (or was lossily decoded).
 * Used as defense-in-depth when extension checks miss a binary file.
 */
export function looksLikeBinaryText(content: string): boolean {
  if (!content) {
    return false;
  }

  const sample = content.length > 8192 ? content.slice(0, 8192) : content;
  if (sample.includes('\0')) {
    return true;
  }
  if (sample.startsWith('%PDF')) {
    return true;
  }
  // ZIP-based formats (docx/xlsx/pptx/jar/apk…) and raw ZIP.
  if (
    sample.startsWith('PK\u0003\u0004') ||
    sample.startsWith('PK\u0005\u0006') ||
    sample.startsWith('PK\u0007\u0008')
  ) {
    return true;
  }

  let suspicious = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code === 0xFFFD) {
      suspicious += 1;
      continue;
    }
    // C0 controls excluding common whitespace (TAB/LF/VT/FF/CR).
    if (code < 9 || (code > 13 && code < 32) || code === 127) {
      suspicious += 1;
    }
  }

  return sample.length > 0 && suspicious / sample.length > 0.1;
}

export function getImageMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'webp': 'image/webp',
    'ico': 'image/x-icon',
    'bmp': 'image/bmp',
    'avif': 'image/avif',
  };
  return mimeMap[ext || ''] || 'image/png';
}

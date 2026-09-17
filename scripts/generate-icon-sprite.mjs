/**
 * Generates the SVG icon sprite file from @remixicon/react bundle.
 *
 * Usage: bun run scripts/generate-icon-sprite.mjs
 *
 * Reads the minified @remixicon/react bundle, extracts SVG path data
 * for all Ri* icons used in packages/ui/src, and writes
 * packages/ui/src/components/icon/sprite.ts.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "..")
const remixPath = resolve(repoRoot, "node_modules/@remixicon/react/index.mjs")
const outPath = resolve(repoRoot, "packages/ui/src/components/icon/sprite.ts")

const customIconData = new Map([
  [
    "arch-linux",
    `<path fill="currentColor" d="M12 2.2c-1.06 2.6-1.7 4.3-2.88 6.82.72.76 1.6 1.65 3.04 2.66-1.55-.64-2.61-1.29-3.4-1.96-1.5 3.13-3.83 7.57-6.76 12.08 2.3-1.33 4.09-2.15 5.76-2.47-.08-.35-.13-.73-.12-1.13l.01-.08c.06-2.25 1.23-3.98 2.61-3.87 1.38.1 2.45 2 2.39 4.25-.01.39-.06.76-.14 1.1 1.66.33 3.44 1.15 5.72 2.47-1.16-1.8-2.22-3.62-3.16-5.35-.74-.57-1.51-1.3-2.95-2.04.99.26 1.7.57 2.25.92C13.03 13.04 12.2 11.05 12 10.4c-.2.65-1.03 2.64-2.37 5.2.55-.35 1.26-.66 2.25-.92-1.44.74-2.21 1.47-2.95 2.04A78.9 78.9 0 0 1 5.77 22.07c2.28-1.32 4.06-2.14 5.72-2.47-.08-.34-.13-.71-.14-1.1-.06-2.25 1.01-4.15 2.39-4.25 1.38-.11 2.55 1.62 2.61 3.87l.01.08c.01.4-.04.78-.12 1.13 1.67.32 3.46 1.14 5.76 2.47-2.93-4.51-5.26-8.95-6.76-12.08-.79.67-1.85 1.32-3.4 1.96 1.44-1.01 2.32-1.9 3.04-2.66C13.7 6.5 13.06 4.8 12 2.2Z"/>`,
  ],
  [
    "nixos",
    `<path fill="currentColor" d="m7.1 4.2 2.05 3.55-1.18 2.04L4.75 4.2H7.1Zm4.9-2.1 2.05 3.55h2.36L14.36 2.1H12Zm4.9 2.1-4.73 8.2h2.36l4.73-8.2H16.9Zm2.84 4.9h-4.1l-1.18 2.04h6.46l-1.18-2.04Zm-2.84 10.7-2.05-3.55 1.18-2.04 3.22 5.59H16.9ZM12 21.9l-2.05-3.55H7.59l2.05 3.55H12Zm-4.9-2.1 4.73-8.2H9.47l-4.73 8.2H7.1ZM4.26 14.9h4.1l1.18-2.04H3.08l1.18 2.04Z"/>`,
  ],
  [
    "fedora",
    `<path fill="currentColor" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm2.9 5.2h-1.35c-.83 0-1.5.67-1.5 1.5v1.35h2.35v2h-2.35v4.15a2.8 2.8 0 0 1-2.8 2.8 2.8 2.8 0 0 1-2.8-2.8c0-1.55 1.25-2.8 2.8-2.8h.8v2h-.8a.8.8 0 1 0 .8.8V8.7a3.5 3.5 0 0 1 3.5-3.5h1.35v2Z"/>`,
  ],
  [
    "debian",
    `<path fill="currentColor" d="M13.7 3.1c-2.8-.8-6.2.2-7.7 2.4 1.9-1.5 4.6-2 6.7-1.2 2.9 1.1 4.3 4.1 3.2 6.8-.9 2.2-3.1 3.6-5.3 3.4-1.8-.1-3.3-1.2-3.8-2.7-.5-1.4 0-2.9 1.2-3.7 1-.7 2.4-.7 3.3.1.7.6.9 1.6.5 2.4-.3.6-.9 1-1.5.9-.5 0-.9-.4-1-.8-.1-.4.1-.8.4-1 .3-.2.6-.1.8.1-.1-.5-.7-.8-1.2-.6-.7.2-1.1.9-1 1.6.1 1 1 1.7 2 1.8 1.2.1 2.4-.6 2.9-1.7.7-1.5.2-3.3-1.1-4.3-1.6-1.3-4-1.3-5.7-.1-2.1 1.5-2.9 4.2-2 6.6 1 2.7 3.6 4.5 6.6 4.7 3.8.2 7.4-2.1 8.8-5.6 1.7-4.2-.6-7.8-4.1-9.1Z"/>`,
  ],
  [
    "docker",
    `<path fill="currentColor" d="M13.98 11.08h2.12v-1.9h-2.12v1.9Zm-2.53 0h2.12v-1.9h-2.12v1.9Zm-2.53 0h2.12v-1.9H8.92v1.9Zm-2.53 0h2.12v-1.9H6.39v1.9Zm5.06-2.3h2.12v-1.9h-2.12v1.9Zm-2.53 0h2.12v-1.9H8.92v1.9Zm-2.53 0h2.12v-1.9H6.39v1.9Zm2.53-2.3h2.12v-1.9H8.92v1.9ZM3.86 11.08h2.12v-1.9H3.86v1.9Zm17.9-.13c-.46-.3-1.52-.42-2.31-.27-.1-.78-.54-1.46-1.34-2.08l-.46-.3-.31.45c-.62.93-.79 2.46-.12 3.47-.3.16-.89.38-1.68.36H2.11c-.27 1.57.18 3.63 1.36 5.05 1.15 1.38 2.88 2.08 5.15 2.08 4.92 0 8.57-2.27 10.28-6.39.67.01 2.11 0 2.85-1.42.05-.09.23-.46.3-.61l-.29-.34Z"/>`,
  ],
  // Actual PiChamber brand mark (faceted hex chamber + pi), matching
  // PiChamberLogo and packages/electron/resources/icons/app-icon-glyph.svg.
  // Artwork is authored in a 100-unit space; scale it into the shared 24-unit
  // sprite grid with 1px padding. Stays currentColor so nav/selection theming
  // behaves like every other sprite glyph.
  [
    "pichamber",
    `<g transform="translate(12 12) scale(0.22) translate(-50 -50)"><path d="M50 3 91 27 50 51 9 27Z" fill="currentColor" fill-opacity="0.08"/><path d="M9 27 50 51V97L9 73Z" fill="currentColor" fill-opacity="0.15"/><path d="M50 51 91 27V73L50 97Z" fill="currentColor" fill-opacity="0.24"/><path d="M50 3 91 27V73L50 97 9 73V27Z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M28 31H72 M38 31V68 M62 31V55C62 64 67 68 75 68" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></g>`,
  ],
])

const source = readFileSync(remixPath, "utf-8")

// --- Step 1: extract variable → path mapping ---
// Pattern: const VARNAME=({color:...})=>...createElement("path",{d:"PATH_DATA"})...,
// Each icon is defined as `const X=...` where X is 1-4 chars.
const varPathMap = new Map()
const varRegex = /(?:[,;]const |\),)([A-Za-z0-9_$]{1,4})=\([{]color:/g
// Find all variable definitions and their boundaries
const varPositions = []
let m
while ((m = varRegex.exec(source)) !== null) {
  varPositions.push({
    varName: m[1],
    start: m.index + m[0].length - 1, // first `{` after `=({color:`
  })
}

for (let i = 0; i < varPositions.length; i++) {
  const current = varPositions[i]
  const next = varPositions[i + 1]
  // End at the )), just before the next variable definition
  const end = next
    ? source.indexOf("))," + next.varName + "=(", current.start)
    : source.length
  if (end < 0 || end < current.start) continue
  const segment = source.slice(current.start, end)
  const pathRegex = /\w+\.createElement\("path",[{]d:"([^"]*)"/g
  let pm
  const paths = []
  while ((pm = pathRegex.exec(segment)) !== null) {
    paths.push(pm[1])
  }
  if (paths.length > 0) {
    varPathMap.set(current.varName, paths)
  }
}

// --- Step 2: extract export mapping ---
// The export map is near the end of the file:
// export{V1 as Ri...Z2 as RiLast};
const exportRegex = /export[{]([^}]+)[}]/
const exportMatch = exportRegex.exec(source)
if (!exportMatch) {
  console.error("Could not find export mapping in remixicon bundle")
  process.exit(1)
}

const nameToVar = new Map()
const entries = exportMatch[1].split(",")
for (const entry of entries) {
  // Pattern: VAR as RiIconName
  const parts = entry.trim().split(" as ")
  if (parts.length === 2) {
    nameToVar.set(parts[1].trim(), parts[0].trim())
  }
}

const remixToSpriteName = (name) => {
  // RiArrowDownSLine → arrow-down-s
  // RiGithubFill → github-fill (keep Fill for fill variants)
  return name
    .replace(/^Ri/, "")
    .replace(/Line$/, "")
    .replace(/([a-z])([A-Z0-9])/g, "$1-$2")
    .replace(/([0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
}

const spriteNameToRi = new Map()
const hasRemixVariantSuffix = (name) => name.endsWith("Line") || name.endsWith("Fill")
const shouldPreferSpriteCandidate = (current, candidate) => {
  if (!current) return true
  if (!hasRemixVariantSuffix(candidate) && hasRemixVariantSuffix(current)) return true
  if (!hasRemixVariantSuffix(current)) return false
  if (candidate.endsWith("Line") && !current.endsWith("Line")) return true
  return false
}

for (const iconName of nameToVar.keys()) {
  const spriteName = remixToSpriteName(iconName)
  const current = spriteNameToRi.get(spriteName)
  if (shouldPreferSpriteCandidate(current, iconName)) {
    spriteNameToRi.set(spriteName, iconName)
  }
}

// --- Step 3: find which icons we actually use ---
const srcDir = resolve(repoRoot, "packages/ui/src")

// Helper: convert kebab-case name back to RiName
function nameToRi(kebab) {
  // "arrow-down-sline" → RiArrowDownSline
  const parts = kebab.split("-")
  let result = "Ri"
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (i > 0 && /^\d/.test(part)) {
      result += part[0].toUpperCase() + part.slice(1)
    } else {
      result += part.charAt(0).toUpperCase() + part.slice(1)
    }
  }
  return result
}

// Finish step 3 synchronously with simpler approach
function findAllSourceFiles(dir) {
  const results = []
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    try {
      const st = statSync(full)
      if (st.isDirectory()) {
        if (entry === "node_modules") continue
        results.push(...findAllSourceFiles(full))
      } else if (/\.(tsx?)$/.test(entry) && full !== outPath) {
        results.push(full)
      }
    } catch { /* skip */ }
  }
  return results
}

const allSrcFiles = findAllSourceFiles(srcDir)
const usedIcons = new Set()
const usedCustomIcons = new Set()
const addKebabIcon = (kebab) => {
  if (customIconData.has(kebab)) {
    usedCustomIcons.add(kebab)
    return true
  }

  const exactRiName = spriteNameToRi.get(kebab)
  if (exactRiName && !hasRemixVariantSuffix(exactRiName)) {
    usedIcons.add(exactRiName)
    return true
  }

  for (const suffix of ["Line", "Fill", ""]) {
    const riName = nameToRi(kebab) + suffix
    if (nameToVar.has(riName)) {
      usedIcons.add(riName)
      return true
    }
  }

  if (exactRiName) {
    usedIcons.add(exactRiName)
    return true
  }

  return false
}

const addIconLiterals = (content) => {
  const iconLiteralRegex = /["']([a-z][a-z0-9-]*)["']/g
  let literal
  while ((literal = iconLiteralRegex.exec(content)) !== null) {
    addKebabIcon(literal[1])
  }
}

function findMatchingBrace(content, openBraceIndex) {
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let i = openBraceIndex; i < content.length; i++) {
    const char = content[i]
    const next = content[i + 1]

    if (lineComment) {
      if (char === "\n") lineComment = false
      continue
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        i++
      }
      continue
    }

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === "/" && next === "/") {
      lineComment = true
      i++
      continue
    }

    if (char === "/" && next === "*") {
      blockComment = true
      i++
      continue
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }

    if (char === "{") {
      depth++
    } else if (char === "}") {
      depth--
      if (depth === 0) return i
    }
  }

  return -1
}

const addIconNameFunctionReturns = (content) => {
  const functionRegex = /function\s+\w+\s*\([^)]*\)\s*:\s*IconName(?:\s*\|\s*null)?\s*{/g
  let match
  while ((match = functionRegex.exec(content)) !== null) {
    const openBraceIndex = content.indexOf("{", match.index)
    if (openBraceIndex === -1) continue

    const closeBraceIndex = findMatchingBrace(content, openBraceIndex)
    if (closeBraceIndex === -1) continue

    const body = content.slice(openBraceIndex + 1, closeBraceIndex)
    const returnRegex = /\breturn\s+["']([a-z][a-z0-9-]*)["']/g
    let returnMatch
    while ((returnMatch = returnRegex.exec(body)) !== null) {
      addKebabIcon(returnMatch[1])
    }
    functionRegex.lastIndex = closeBraceIndex + 1
  }
}

const addTypedIconNameRecords = (content) => {
  const recordRegex = /:\s*Record<[^>]*IconName[^>]*>\s*=\s*{/g
  let match
  while ((match = recordRegex.exec(content)) !== null) {
    const openBraceIndex = content.indexOf("{", match.index)
    if (openBraceIndex === -1) continue

    const closeBraceIndex = findMatchingBrace(content, openBraceIndex)
    if (closeBraceIndex === -1) continue

    addIconLiterals(content.slice(openBraceIndex + 1, closeBraceIndex))
    recordRegex.lastIndex = closeBraceIndex + 1
  }
}

const addIconNameVariableAssignments = (content) => {
  if (!/<Icon\b/.test(content)) return

  const variableRegex = /\b(?:const|let|var)\s+\w*IconName\b[^=]*=\s*([\s\S]*?);/g
  let match
  while ((match = variableRegex.exec(content)) !== null) {
    const initializer = match[1]
    const directLiteral = /^\s*["']([a-z][a-z0-9-]*)["']/.exec(initializer)
    if (directLiteral) {
      addKebabIcon(directLiteral[1])
    }

    const branchLiteralRegex = /(?:\?\?|[?:])\s*["']([a-z][a-z0-9-]*)["']/g
    let branchLiteral
    while ((branchLiteral = branchLiteralRegex.exec(initializer)) !== null) {
      addKebabIcon(branchLiteral[1])
    }
  }
}

for (const file of allSrcFiles) {
  const content = readFileSync(file, "utf-8")
  // Match RiIcons from @remixicon/react imports
  const iconRegex = /Ri[A-Z][A-Za-z0-9]+/g
  let im
  while ((im = iconRegex.exec(content)) !== null) {
    if (nameToVar.has(im[0])) {
      usedIcons.add(im[0])
    }
  }

  // Also scan for <Icon name="..." /> patterns (already-migrated icons)
  const iconNameRegex = /<Icon\b[^>]*\bname=(?:["']([^"']+)["']|{\s*["']([^"']+)["']\s*})/g
  let nm
  while ((nm = iconNameRegex.exec(content)) !== null) {
    addKebabIcon(nm[1] || nm[2])
  }

  // Also scan for icon: 'kebab-name' / Icon: 'kebab-name' in object literals.
  const iconPropRegex = /\b[Ii]con:\s*["']([a-z][a-z0-9-]*)["']/g
  let ip
  while ((ip = iconPropRegex.exec(content)) !== null) {
    addKebabIcon(ip[1])
  }

  // Also scan JSX props named icon/Icon with a string literal value.
  const iconJsxPropRegex = /\b[Ii]con=(?:["']([^"']+)["']|{\s*["']([^"']+)["']\s*})/g
  let jp
  while ((jp = iconJsxPropRegex.exec(content)) !== null) {
    addKebabIcon(jp[1] || jp[2])
  }

  addIconNameFunctionReturns(content)
  addTypedIconNameRecords(content)
  addIconNameVariableAssignments(content)
}

console.log(`Found ${usedIcons.size} unique remixicon names used in source`)

// --- Step 4: build sprite data ---
const iconEntries = []
for (const iconName of [...usedIcons].sort()) {
  const varName = nameToVar.get(iconName)
  if (!varName) {
    console.warn(`  ⚠ Unknown icon: ${iconName}`)
    continue
  }
  const paths = varPathMap.get(varName)
  if (!paths || paths.length === 0) {
    console.warn(`  ⚠ No path data for: ${iconName} (var: ${varName})`)
    continue
  }

  // Build SVG content from paths
  const svgContent = paths
    .map((d) => `<path d="${d}" fill="currentColor"/>`)
    .join("")

  iconEntries.push({ name: iconName, content: svgContent })
}

for (const iconName of [...usedCustomIcons].sort()) {
  iconEntries.push({ name: iconName, content: customIconData.get(iconName) })
}

// --- Step 5: write sprite.ts ---
const spriteLines = iconEntries
  .map(({ name, content }) => ({
    name: name.startsWith("Ri") ? remixToSpriteName(name) : name,
    content,
  }))
  .sort((left, right) => left.name.localeCompare(right.name))
  .map(({ name, content }) => `  "${name}": \`${content}\`,`)

const spriteContent = `// This file is auto-generated by scripts/generate-icon-sprite.mjs
// Do not edit manually. Run the script to update.

export const iconSpriteData = {
${spriteLines.join("\n")}
} as const satisfies Record<string, string>;
`

writeFileSync(outPath, spriteContent, "utf-8")
console.log(`\n✅ Generated sprite data for ${iconEntries.length} icons → ${outPath}`)
console.log(`   Total sprite size: ${Buffer.byteLength(spriteContent).toLocaleString()} bytes`)

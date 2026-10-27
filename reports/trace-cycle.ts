import fs from "node:fs"
import path from "node:path"

const root = path.resolve(process.argv[2] ?? "src")
const startAbs = path.resolve(process.argv[3])
const targetAbs = path.resolve(process.argv[4])

function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null
  const base = path.resolve(path.dirname(from), spec)
  for (const c of [base, base + ".ts", base + ".tsx", path.join(base, "index.ts")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return null
}

function imports(file: string): string[] {
  if (!fs.existsSync(file)) return []
  const src = fs.readFileSync(file, "utf8")
  const out: string[] = []
  const re =
    /(?:^|\n)[ \t]*import[\s\S]{0,400}?from\s*["']([^"']+)["']|(?:^|\n)[ \t]*export[\s\S]{0,400}?from\s*["']([^"']+)["']|(?:^|\n)[ \t]*import\s*["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const spec = (m[1] || m[2]) as string
    const r = resolve(file, spec)
    if (r) out.push(r)
  }
  return out
}

const queue: string[][] = [[startAbs]]
const seen = new Set([startAbs])
while (queue.length) {
  const p = queue.shift()!
  const last = p[p.length - 1]
  if (last === targetAbs) {
    console.log("PATH: " + p.map((x) => path.relative(root, x)).join("\n  -> "))
    process.exit(0)
  }
  for (const nxt of imports(last)) {
    if (seen.has(nxt)) continue
    seen.add(nxt)
    queue.push([...p, nxt])
  }
}
console.log("no import path")

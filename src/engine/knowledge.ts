import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface ImportEdge {
  /** The raw module specifier, e.g. "./foo" or "node:fs". */
  from: string;
  /** Imported names (best-effort). */
  names: string[];
}
export interface FileNode {
  file: string; // relative to project root
  imports: ImportEdge[];
  exports: string[];
}
export interface Knowledge {
  scan(): { files: number };
  queryImports(file: string): ImportEdge[] | null;
  queryExports(file: string): string[] | null;
  queryDependents(file: string): string[];
  listFiles(): string[];
}

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "build", ".next"]);

function parseImports(src: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const fromRe = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  const bareRe = /import\s*['"]([^'"]+)['"]/g;
  const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src))) edges.push({ from: m[2]!, names: parseClause(m[1]!) });
  while ((m = bareRe.exec(src))) edges.push({ from: m[1]!, names: [] });
  while ((m = reqRe.exec(src))) edges.push({ from: m[1]!, names: [] });
  return edges;
}

function parseClause(clause: string): string[] {
  const names: string[] = [];
  const braced = clause.match(/\{([^}]*)\}/);
  if (braced) {
    for (const part of braced[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
  }
  const star = clause.match(/\*\s+as\s+([A-Za-z0-9_$]+)/);
  if (star) names.push(star[1]!);
  const def = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+[A-Za-z0-9_$]+/, "").trim().replace(/,$/, "").trim();
  if (def && /^[A-Za-z0-9_$]+$/.test(def)) names.push(def);
  return names;
}

function parseExports(src: string): string[] {
  const names = new Set<string>();
  const declRe = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/g;
  const listRe = /export\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src))) names.add(m[1]!);
  while ((m = listRe.exec(src))) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default\b/.test(src)) names.add("default");
  return [...names];
}

/** Project-scoped import/export graph. Regex-based (TS/JS), dependency-free. */
export function createKnowledge(projectRoot: string, cacheDir: string): Knowledge {
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, "graph.json");
  const graph = new Map<string, FileNode>();
  let scanned = false;

  if (existsSync(cachePath)) {
    try {
      const nodes = JSON.parse(readFileSync(cachePath, "utf8")) as FileNode[];
      for (const n of nodes) graph.set(n.file, n);
      scanned = true;
    } catch {
      /* rebuild on next query */
    }
  }

  const norm = (file: string): string => relative(projectRoot, resolve(projectRoot, file)).split("\\").join("/");

  function walk(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, out);
      else if (SOURCE_EXT.test(entry)) out.push(full);
    }
  }

  function doScan(): { files: number } {
    graph.clear();
    const files: string[] = [];
    walk(projectRoot, files);
    for (const full of files) {
      const src = readFileSync(full, "utf8");
      const file = norm(full);
      graph.set(file, { file, imports: parseImports(src), exports: parseExports(src) });
    }
    const tmp = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...graph.values()]), "utf8");
    renameSync(tmp, cachePath);
    scanned = true;
    return { files: graph.size };
  }

  const ensure = (): void => {
    if (!scanned || graph.size === 0) doScan();
  };

  /** Resolve a relative import specifier from `nodeFile` to a known graph file. */
  function resolveEdge(nodeFile: string, spec: string): string | null {
    if (!spec.startsWith(".")) return null; // external/node module
    const base = resolve(projectRoot, dirname(nodeFile), spec);
    const baseRel = relative(projectRoot, base).split("\\").join("/");
    const candidates = [
      baseRel,
      ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].flatMap((e) => [
        `${baseRel}.${e}`,
        `${baseRel}/index.${e}`,
      ]),
      // imports often use .js for NodeNext — also try swapping to .ts
      baseRel.replace(/\.js$/, ".ts"),
    ];
    for (const c of candidates) if (graph.has(c)) return c;
    return null;
  }

  return {
    scan: doScan,
    queryImports(file) {
      ensure();
      return graph.get(norm(file))?.imports ?? null;
    },
    queryExports(file) {
      ensure();
      return graph.get(norm(file))?.exports ?? null;
    },
    listFiles() {
      ensure();
      return [...graph.keys()];
    },
    queryDependents(file) {
      ensure();
      const target = norm(file);
      const deps: string[] = [];
      for (const node of graph.values()) {
        for (const edge of node.imports) {
          if (resolveEdge(node.file, edge.from) === target) {
            deps.push(node.file);
            break;
          }
        }
      }
      return deps;
    },
  };
}

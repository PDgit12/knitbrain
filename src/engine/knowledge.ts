import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { writeAtomic } from "../atomic.js";
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

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|rb|php)$/;

/** Language family by extension — routes comment-stripping + import/export
 *  parsing. Same regex-over-AST philosophy as JS: cheap, best-effort, and the
 *  graph only needs edges + names, not full semantics. */
type Lang = "js" | "py" | "go" | "rs" | "java" | "rb" | "php";
export function langOf(file: string): Lang {
  const ext = file.split(".").pop() ?? "";
  if (ext === "py") return "py";
  if (ext === "go") return "go";
  if (ext === "rs") return "rs";
  if (ext === "java") return "java";
  if (ext === "rb") return "rb";
  if (ext === "php") return "php";
  return "js";
}
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "build", ".next"]);

/** Strip block + line comments so prose words like "import"/"export" inside a
 *  JSDoc can't be parsed as real statements (the lazy import regex would
 *  otherwise span a comment to the next `from '...'` and eat the real binding).
 *  Best-effort: string-literal bodies aren't spared, which is fine for the graph.
 *  The `[^:]` guard keeps `://` in URL strings from being clipped. */
function stripComments(src: string, lang: Lang = "js"): string {
  if (lang === "py" || lang === "rb") {
    return src.replace(/(^|[^'"#])#[^\n]*/gm, "$1");
  }
  const cStyle = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  // PHP additionally allows shell-style line comments.
  return lang === "php" ? cStyle.replace(/(^|[^'"#])#[^\n]*/gm, "$1") : cStyle;
}

function parseImports(src: string, lang: Lang = "js"): ImportEdge[] {
  const edges: ImportEdge[] = [];
  let m: RegExpExecArray | null;
  if (lang === "js") {
    const fromRe = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
    const bareRe = /import\s*['"]([^'"]+)['"]/g;
    const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = fromRe.exec(src))) edges.push({ from: m[2]!, names: parseClause(m[1]!) });
    while ((m = bareRe.exec(src))) edges.push({ from: m[1]!, names: [] });
    while ((m = reqRe.exec(src))) edges.push({ from: m[1]!, names: [] });
    return edges;
  }
  if (lang === "py") {
    const fromRe = /^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+([^\n#]+)/gm;
    const impRe = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm;
    while ((m = fromRe.exec(src))) {
      const names = m[2]!.split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean);
      edges.push({ from: m[1]!, names });
    }
    while ((m = impRe.exec(src))) for (const mod of m[1]!.split(",")) edges.push({ from: mod.trim(), names: [] });
    return edges;
  }
  if (lang === "go") {
    const single = /import\s+(?:\w+\s+)?"([^"]+)"/g;
    const block = /import\s*\(([\s\S]*?)\)/g;
    while ((m = single.exec(src))) edges.push({ from: m[1]!, names: [] });
    while ((m = block.exec(src))) {
      let inner: RegExpExecArray | null;
      const line = /"([^"]+)"/g;
      while ((inner = line.exec(m[1]!))) edges.push({ from: inner[1]!, names: [] });
    }
    return edges;
  }
  if (lang === "rs") {
    const useRe = /\buse\s+([\w:]+?)(?:::\{([^}]*)\})?\s*;/g;
    const modRe = /\bmod\s+(\w+)\s*;/g;
    while ((m = useRe.exec(src))) {
      const names = (m[2] ?? "").split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!.trim()).filter((n) => n && n !== "*");
      edges.push({ from: m[1]!, names });
    }
    while ((m = modRe.exec(src))) edges.push({ from: `self::${m[1]!}`, names: [] });
    return edges;
  }
  if (lang === "java") {
    const impRe = /import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?\s*;/g;
    while ((m = impRe.exec(src))) edges.push({ from: m[1]!, names: [] });
    return edges;
  }
  if (lang === "rb") {
    const relRe = /require_relative\s+['"]([^'"]+)['"]/g;
    const reqRe = /(?<!_)require\s+['"]([^'"]+)['"]/g;
    while ((m = relRe.exec(src))) edges.push({ from: m[1]!.startsWith(".") ? m[1]! : `./${m[1]!}`, names: [] });
    while ((m = reqRe.exec(src))) edges.push({ from: m[1]!, names: [] });
    return edges;
  }
  // php
  const useRe = /\buse\s+([\w\\]+)/g;
  const incRe = /(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g;
  while ((m = useRe.exec(src))) edges.push({ from: m[1]!, names: [] });
  while ((m = incRe.exec(src))) edges.push({ from: m[1]!, names: [] });
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

function parseExports(src: string, lang: Lang = "js"): string[] {
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  const collect = (re: RegExp): void => {
    let g: RegExpExecArray | null;
    while ((g = re.exec(src))) {
      const name = g.slice(1).find((x) => x !== undefined);
      if (name) names.add(name);
    }
  };
  if (lang === "js") {
    const declRe = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/g;
    const listRe = /export\s*\{([^}]*)\}/g;
    while ((m = declRe.exec(src))) names.add(m[1]!);
    while ((m = listRe.exec(src))) {
      for (const part of m[1]!.split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) names.add(name);
      }
    }
    if (/export\s+default\b/.test(src)) names.add("default");
  } else if (lang === "py") {
    collect(/^(?:async[ \t]+)?def[ \t]+(\w+)/gm); // top-level only (no indent)
    collect(/^class[ \t]+(\w+)/gm);
  } else if (lang === "go") {
    // Go's export rule IS capitalization.
    collect(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm);
    collect(/^type\s+([A-Z]\w*)/gm);
    collect(/^(?:var|const)\s+([A-Z]\w*)/gm);
  } else if (lang === "rs") {
    collect(/\bpub(?:\([^)]*\))?\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|mod|const|static|type)\s+(\w+)/g);
  } else if (lang === "java") {
    collect(/(?:public|protected)\s+(?:(?:static|final|abstract|sealed)\s+)*(?:class|interface|enum|record)\s+(\w+)/g);
  } else if (lang === "rb") {
    collect(/^(?:class|module)[ \t]+([A-Z]\w*)/gm);
    collect(/^def[ \t]+(?:self\.)?(\w+[?!]?)/gm);
  } else {
    // php
    collect(/^[ \t]*(?:abstract[ \t]+|final[ \t]+)?(?:class|interface|trait)[ \t]+(\w+)/gm);
    collect(/^[ \t]*function[ \t]+(\w+)/gm);
  }
  return [...names];
}

/** Project-scoped import/export graph. Regex-based (TS/JS), dependency-free. */
export function createKnowledge(projectRoot: string, cacheDir: string): Knowledge {
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, "graph.json");
  const graph = new Map<string, FileNode>();
  // Reverse adjacency index: target file → files that import it. Built once
  // whenever the graph (re)loads, so queryDependents is an O(1) lookup instead
  // of re-resolving every edge in the graph on every call (O(V·E) per query).
  const dependents = new Map<string, Set<string>>();
  let scanned = false;

  if (existsSync(cachePath)) {
    try {
      const nodes = JSON.parse(readFileSync(cachePath, "utf8")) as FileNode[];
      // Ghost-prune: drop cached nodes for files deleted since the last scan,
      // so a stale cache never reports a file that no longer exists.
      for (const n of nodes) if (existsSync(resolve(projectRoot, n.file))) graph.set(n.file, n);
      buildReverseIndex();
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
      const file = norm(full);
      const lang = langOf(file);
      const src = stripComments(readFileSync(full, "utf8"), lang);
      graph.set(file, { file, imports: parseImports(src, lang), exports: parseExports(src, lang) });
    }
    buildReverseIndex();
    writeAtomic(cachePath, JSON.stringify([...graph.values()]));
    scanned = true;
    return { files: graph.size };
  }

  /** Resolve every edge once and invert the graph into `dependents`. Runs at
   * scan/load time so per-query dependent lookup is O(1). */
  function buildReverseIndex(): void {
    dependents.clear();
    for (const node of graph.values()) {
      for (const edge of node.imports) {
        const target = resolveEdge(node.file, edge.from);
        if (target === null) continue;
        let set = dependents.get(target);
        if (set === undefined) {
          set = new Set();
          dependents.set(target, set);
        }
        set.add(node.file);
      }
    }
  }

  const ensure = (): void => {
    if (!scanned || graph.size === 0) doScan();
  };

  /** Longest-suffix match: find the graph file whose path ends with the given
   *  segment suffix (module paths rarely equal file paths outside JS — Python
   *  dotted modules, Rust crate paths, Java packages, Go package dirs).
   *  Shortest matching key wins (least-nested = most canonical), deterministic. */
  function tailMatch(suffixes: string[]): string | null {
    let best: string | null = null;
    for (const key of graph.keys()) {
      for (const suf of suffixes) {
        if (key === suf || key.endsWith(`/${suf}`)) {
          if (best === null || key.length < best.length || (key.length === best.length && key < best)) best = key;
        }
      }
    }
    return best;
  }

  /** Resolve an import specifier from `nodeFile` to a known graph file —
   *  relative paths exactly (per-language extension candidates), module/crate/
   *  package paths by longest-suffix match. Null = external dependency. */
  function resolveEdge(nodeFile: string, spec: string): string | null {
    const lang = langOf(nodeFile);

    // Rust self::/super:: (incl. `mod x;` recorded as self::x) are directory-relative.
    if (lang === "rs" && /^(self|super)::/.test(spec)) {
      const up = spec.startsWith("super::") ? ".." : ".";
      const segs = spec.replace(/^(self|super)::/, "").split("::");
      const base = resolve(projectRoot, dirname(nodeFile), up, ...segs);
      const baseRel = relative(projectRoot, base).split("\\").join("/");
      for (const c of [`${baseRel}.rs`, `${baseRel}/mod.rs`]) if (graph.has(c)) return c;
      return null;
    }

    if (spec.startsWith(".")) {
      const base = resolve(projectRoot, dirname(nodeFile), spec);
      const baseRel = relative(projectRoot, base).split("\\").join("/");
      const exts =
        lang === "js"
          ? ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]
          : lang === "py"
            ? ["py"]
            : lang === "rb"
              ? ["rb"]
              : lang === "php"
                ? ["php"]
                : [nodeFile.split(".").pop() ?? ""];
      const candidates = [
        baseRel,
        ...exts.flatMap((e) => [`${baseRel}.${e}`, `${baseRel}/index.${e}`]),
        `${baseRel}/__init__.py`,
        `${baseRel}/mod.rs`,
        // imports often use .js for NodeNext — also try swapping to .ts
        baseRel.replace(/\.js$/, ".ts"),
      ];
      for (const c of candidates) if (graph.has(c)) return c;
      return null;
    }

    if (lang === "py") {
      const pathy = spec.split(".").join("/");
      return tailMatch([`${pathy}.py`, `${pathy}/__init__.py`]);
    }
    if (lang === "rs") {
      const segs = spec.split("::");
      if (segs[0] === "crate") segs.shift();
      if (segs.length === 0) return null;
      const pathy = segs.join("/");
      const parent = segs.slice(0, -1).join("/");
      const sufs = [`${pathy}.rs`, `${pathy}/mod.rs`];
      // `use crate::scheduler::spawn` — last seg may be an ITEM, not a module.
      if (parent) sufs.push(`${parent}.rs`, `${parent}/mod.rs`);
      return tailMatch(sufs);
    }
    if (lang === "java") {
      return tailMatch([`${spec.split(".").join("/")}.java`]);
    }
    if (lang === "php") {
      return tailMatch([`${spec.split("\\").filter(Boolean).join("/")}.php`]);
    }
    if (lang === "go") {
      // Module path tail names a package DIR — match any file inside it is
      // ambiguous; match the dir's doc-conventional file name instead.
      const last = spec.split("/").pop()!;
      return tailMatch([`${last}/${last}.go`, `${last}/main.go`, `${last}.go`]);
    }
    if (lang === "rb") {
      return tailMatch([`${spec}.rb`]);
    }
    return null; // js external module
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
      // O(1) lookup against the reverse index (built once at scan), instead of
      // re-resolving every edge in the graph on each call.
      return [...(dependents.get(norm(file)) ?? [])];
    },
  };
}

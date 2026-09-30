import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export type SourceSnapshot = {
  routes: { method: string; path: string; file: string; line: number }[];
  env: {
    name: string;
    required: boolean;
    flag: boolean;
    locations: string[];
  }[];
  todos: { file: string; line: number; text: string }[];
};

type SourceFile = {
  absolute: string;
  relative: string;
  source: string;
  ast: ts.SourceFile;
};

type TextFile = { relative: string; source: string };
type Route = SourceSnapshot["routes"][number];

const ignoredDirectories = new Set([
  "node_modules",
  "dist",
  "memory",
  ".git",
  ".local",
  ".agents",
]);
const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);

function isSnapshotScript(relative: string): boolean {
  return /^scripts\/snapshot(?:-[^/]*)?\.[^.]+$/.test(relative);
}

async function walk(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await walk(path.join(directory, entry.name))));
      }
    } else if (entry.isFile()) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

async function findSourceFiles(root: string): Promise<{ files: SourceFile[]; textFiles: TextFile[] }> {
  const roots = ["artifacts", "lib", "scripts", "src"].map((name) =>
    path.join(root, name),
  );
  const sourceDirectories: string[] = [];
  const findSourceDirectories = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (entry.name === "src") {
        sourceDirectories.push(child);
      } else {
        await findSourceDirectories(child);
      }
    }
  };
  sourceDirectories.push(path.join(root, "src"));
  for (const directory of roots) await findSourceDirectories(directory);

  const allSourceTreeFiles = [...new Set((await Promise.all(sourceDirectories.map(walk))).flat())];
  const codePaths = new Set(
    (await Promise.all(roots.map(walk))).flat().filter((absolute) =>
      sourceExtensions.has(path.extname(absolute)),
    ),
  );
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
        codePaths.add(path.join(root, entry.name));
      }
    }
  } catch {
    // A missing or unreadable root simply contributes no root-level config files.
  }
  for (const absolute of [...codePaths]) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (isSnapshotScript(relative)) codePaths.delete(absolute);
  }

  const files = await Promise.all(
    [...codePaths].map(async (absolute) => {
      const source = await readFile(absolute, "utf8");
      const scriptKind = absolute.endsWith(".tsx") || absolute.endsWith(".jsx")
        ? ts.ScriptKind.TSX
        : absolute.endsWith(".js") || absolute.endsWith(".mjs") || absolute.endsWith(".cjs")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
      return {
        absolute,
        relative: path.relative(root, absolute).split(path.sep).join("/"),
        source,
        ast: ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true, scriptKind),
      };
    }),
  );
  const textByPath = new Map<string, TextFile>();
  for (const absolute of allSourceTreeFiles) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (isSnapshotScript(relative)) continue;
    try {
      const source = await readFile(absolute, "utf8");
      // Treat files containing NULs as binary, not as source text.
      if (source.includes("\0")) continue;
      textByPath.set(relative, { relative, source });
    } catch {
      // Skip unreadable files; other source files remain available.
    }
  }
  return { files, textFiles: [...textByPath.values()] };
}

function stringLiteral(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function pathValues(node: ts.Expression): string[] {
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) =>
      ts.isExpression(element) ? pathValues(element) : [],
    );
  }
  const literal = stringLiteral(node);
  if (literal !== undefined) return [literal];
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;
    for (const span of node.templateSpans) {
      result += `\${<dynamic>}${span.literal.text}`;
    }
    return [result];
  }
  // Keep non-literal patterns visible in the snapshot rather than dropping them.
  return ["<dynamic>"];
}

function joinRoutePath(prefix: string, routePath: string): string {
  if (routePath.startsWith("<dynamic:")) {
    return `${prefix.replace(/\/$/, "")}/${routePath}`;
  }
  if (prefix.startsWith("<dynamic:")) {
    return `${prefix.replace(/\/$/, "")}${routePath.startsWith("/") ? "" : "/"}${routePath}`;
  }
  const joined = `${prefix.replace(/\/$/, "")}/${routePath.replace(/^\//, "")}`;
  return joined || "/";
}

function isRouterFactory(node: ts.Expression): boolean {
  return ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "Router";
}

function relativeModulePath(file: SourceFile, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(file.absolute), specifier);
  const candidates = [
    base,
    ...[...sourceExtensions].map((extension) => `${base}${extension}`),
    ...[...sourceExtensions].map((extension) => path.join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => sourceFileByAbsolute.has(candidate));
}

const sourceFileByAbsolute = new Map<string, SourceFile>();

function importsFor(file: SourceFile): Map<string, string> {
  const imported = new Map<string, string>();
  for (const statement of file.ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = relativeModulePath(file, statement.moduleSpecifier.text);
    if (!target || !statement.importClause) continue;
    const clause = statement.importClause;
    if (clause.name) imported.set(clause.name.text, target);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      imported.set(clause.namedBindings.name.text, target);
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const binding of clause.namedBindings.elements) {
        imported.set(binding.name.text, target);
      }
    }
  }
  return imported;
}

function exportedRouterName(file: SourceFile): string | undefined {
  for (const statement of file.ast.statements) {
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      return statement.expression.text;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer &&
            isRouterFactory(declaration.initializer)) {
          const exported = statement.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
          );
          if (exported) return declaration.name.text;
        }
      }
    }
  }
  return undefined;
}

function routerVariables(file: SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.initializer && isRouterFactory(node.initializer)) {
      names.add(node.name.text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "Router") {
      // Routers are occasionally assigned without an obvious declaration shape.
      let parent: ts.Node | undefined = node.parent;
      while (parent && !ts.isVariableDeclaration(parent)) parent = parent.parent;
      if (parent && ts.isIdentifier(parent.name)) names.add(parent.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file.ast);
  return names;
}

function scanRoutes(
  file: SourceFile,
  mountPrefix: string,
  routerName: string,
  routes: Route[],
  recurseMount: (target: string, prefix: string) => void,
): void {
  const calls = new Set<ts.CallExpression>();
  const addRoute = (method: string, routePath: ts.Expression, node: ts.Node) => {
    for (const localPath of pathValues(routePath)) {
      const fullPath = joinRoutePath(mountPrefix, localPath);
      routes.push({
        method: method.toUpperCase(),
        path: fullPath.startsWith("/") || fullPath.startsWith("<dynamic:")
          ? fullPath
          : `/${fullPath}`,
        file: file.relative,
        line: file.ast.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    }
  };
  const parseCallChain = (node: ts.CallExpression): void => {
    if (calls.has(node)) return;
    calls.add(node);
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return;
    const receiver = callee.expression.text;
    const method = callee.name.text.toLowerCase();
    if (receiver !== routerName) return;

    if (method === "route" && node.arguments[0] && ts.isExpression(node.arguments[0])) {
      const routePath = node.arguments[0];
      const inspectChain = (chain: ts.Node) => {
        if (!ts.isCallExpression(chain) || !ts.isPropertyAccessExpression(chain.expression)) return;
        const chainMethod = chain.expression.name.text.toLowerCase();
        if (["get", "post", "put", "patch", "delete", "options", "head", "all"].includes(chainMethod)) {
          addRoute(chainMethod, routePath, chain);
        }
      };
      // Include methods attached to this call and subsequent route(...).get(...) calls.
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent)) {
        let current: ts.Node = parent;
        while (ts.isPropertyAccessExpression(current.parent) ||
               (ts.isCallExpression(current.parent) && current.parent.expression === current)) {
          current = current.parent;
          if (ts.isCallExpression(current)) inspectChain(current);
        }
      }
      return;
    }

    if (method === "use") {
      const args = [...node.arguments];
      let prefixes = [""];
      if (args.length && ts.isExpression(args[0])) {
        const first = args[0];
        const importedRouters = args.some((argument) =>
          ts.isIdentifier(argument) && importsFor(file).has(argument.text),
        );
        const looksLikeDynamicPath =
          ts.isRegularExpressionLiteral(first) ||
          ts.isBinaryExpression(first) ||
          ts.isConditionalExpression(first) ||
          ts.isPropertyAccessExpression(first) ||
          ts.isElementAccessExpression(first) ||
          ts.isIdentifier(first) && /(?:path|prefix|base|url)/i.test(first.text);
        if (stringLiteral(first) !== undefined || ts.isArrayLiteralExpression(first) ||
            ts.isTemplateExpression(first) || importedRouters && looksLikeDynamicPath) {
          prefixes = pathValues(first);
          args.shift();
        }
      }
      for (const argument of args) {
        if (!ts.isIdentifier(argument)) continue;
        const target = importsFor(file).get(argument.text);
        if (target) {
          for (const prefix of prefixes) {
            recurseMount(target, prefix ? joinRoutePath(mountPrefix, prefix) : mountPrefix);
          }
        }
      }
      return;
    }

    if (["get", "post", "put", "patch", "delete", "options", "head", "all"].includes(method) &&
        node.arguments[0] && ts.isExpression(node.arguments[0])) {
      addRoute(method, node.arguments[0], node);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) parseCallChain(node);
    ts.forEachChild(node, visit);
  };
  visit(file.ast);
}

function collectRoutes(files: SourceFile[]): Route[] {
  const byAbsolute = new Map(files.map((file) => [file.absolute, file]));
  sourceFileByAbsolute.clear();
  for (const [absolute, file] of byAbsolute) sourceFileByAbsolute.set(absolute, file);

  const routeFiles = files.filter((file) =>
    /(?:^|\/)routes\//.test(file.relative),
  );
  const appFiles = files.filter((file) =>
    /(?:^|\/)src\/(?:app|index)\.[^.]+$/.test(file.relative),
  );
  const routes: Route[] = [];
  const visited = new Set<string>();
  const visitedFiles = new Set<string>();

  const walkRouter = (absolute: string, prefix: string, preferredName?: string) => {
    const file = byAbsolute.get(absolute);
    if (!file) return;
    visitedFiles.add(absolute);
    const router = preferredName ?? exportedRouterName(file) ?? [...routerVariables(file)][0];
    if (!router) return;
    const key = `${absolute}|${prefix}|${router}`;
    if (visited.has(key)) return;
    visited.add(key);
    scanRoutes(file, prefix, router, routes, (target, childPrefix) => {
      const targetFile = byAbsolute.get(target);
      if (targetFile) walkRouter(target, childPrefix, exportedRouterName(targetFile));
    });
  };

  // Mounts encountered from app and route-index files lead to each exported router.
  for (const appFile of appFiles) {
    scanRoutes(appFile, "", "app", routes, (target, prefix) => {
      const targetFile = byAbsolute.get(target);
      if (targetFile) walkRouter(target, prefix, exportedRouterName(targetFile));
    });
  }

  // Also scan route-directory modules directly, covering routers without a discovered mount.
  for (const file of routeFiles) {
    if (visitedFiles.has(file.absolute)) continue;
    const preferred = exportedRouterName(file) ?? [...routerVariables(file)][0];
    if (preferred) walkRouter(file.absolute, "", preferred);
  }
  return routes.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line ||
    a.method.localeCompare(b.method) || a.path.localeCompare(b.path),
  );
}

type EnvOccurrence = {
  name: string;
  node: ts.Node;
  file: SourceFile;
  alias?: string;
  required: boolean;
  flag: boolean;
};

function environmentBase(node: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) && node.expression.text === "process" &&
    node.name.text === "env" ||
    ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.expression.name.text === "meta" && node.name.text === "env";
}

function envAccess(node: ts.Node): { name: string; access: ts.Node } | undefined {
  if (!ts.isExpression(node)) return undefined;
  if (ts.isPropertyAccessExpression(node) && environmentBase(node.expression)) {
    return { name: node.name.text, access: node };
  }
  if (ts.isElementAccessExpression(node) && environmentBase(node.expression) &&
      node.argumentExpression) {
    const name = stringLiteral(node.argumentExpression);
    if (name !== undefined) return { name, access: node };
  }
  return undefined;
}

function isFlagName(name: string): boolean {
  return /(?:^|_)(?:FLAG|ENABLED?|DISABLED?|LIVE|DEBUG|DRY_RUN|ALLOW|ENABLE|DISABLE|TEST)(?:_|$)/i.test(name) ||
    /(?:FLAG|ENABLED|DISABLED|LIVE|DEBUG|DRY_RUN|ALLOW|ENABLE|DISABLE|TEST)$/i.test(name) ||
    name === "VITE_NAV_MODE";
}

function hasThrow(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node) => {
    if (ts.isThrowStatement(current)) found = true;
    if (!found) ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function referencesIdentifier(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (current: ts.Node) => {
    if (ts.isIdentifier(current) && current.text === name) found = true;
    if (!found) ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function checksForMissingValue(node: ts.Expression, occurrence: EnvOccurrence): boolean {
  const referencesValue = (expression: ts.Expression) => {
    if (occurrence.node.getStart() >= expression.getStart() &&
        occurrence.node.getEnd() <= expression.getEnd()) return true;
    return Boolean(occurrence.alias && referencesIdentifier(expression, occurrence.alias));
  };
  if (ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken) {
    return referencesValue(node.operand);
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      return checksForMissingValue(node.left, occurrence) ||
        checksForMissingValue(node.right, occurrence);
    }
    const isEquality = operator === ts.SyntaxKind.EqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken;
    if (!isEquality) return false;
    const isMissingLiteral = (expression: ts.Expression) =>
      expression.kind === ts.SyntaxKind.NullKeyword ||
      ts.isIdentifier(expression) && expression.text === "undefined" ||
      stringLiteral(expression) === "";
    return isMissingLiteral(node.left) && referencesValue(node.right) ||
      isMissingLiteral(node.right) && referencesValue(node.left);
  }
  return false;
}

function collectEnv(files: SourceFile[]): SourceSnapshot["env"] {
  const occurrences: EnvOccurrence[] = [];
  for (const file of files) {
    const fileOccurrences: EnvOccurrence[] = [];
    const visit = (node: ts.Node) => {
      const access = envAccess(node);
      if (access) {
        const occurrence: EnvOccurrence = {
          name: access.name,
          node: access.access,
          file,
          required: false,
          flag: isFlagName(access.name),
        };
        let current: ts.Node | undefined = access.access;
        while (current && current !== file.ast) {
          if (ts.isNonNullExpression(current)) occurrence.required = true;
          if (ts.isBinaryExpression(current) &&
              (current.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
               current.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
               current.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
               current.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)) {
            const other = current.left === access.access ? current.right : current.left;
            const value = stringLiteral(other);
            if (value === "true" || value === "false") occurrence.flag = true;
          }
          current = current.parent;
        }
        fileOccurrences.push(occurrence);
      }

      if (ts.isVariableDeclaration(node) && node.initializer &&
          ts.isObjectBindingPattern(node.name) && environmentBase(node.initializer)) {
        for (const element of node.name.elements) {
          if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
          const property = element.propertyName
            ? (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
                ? element.propertyName.text
                : undefined)
            : element.name.text;
          if (property) {
            fileOccurrences.push({
              name: property,
              node: element,
              alias: element.name.text,
              file,
              required: Boolean(element.initializer && ts.isNonNullExpression(element.initializer)),
              flag: isFlagName(property),
            });
          }
        }
      }
      if (ts.isVariableDeclaration(node) && node.initializer &&
          ts.isObjectBindingPattern(node.name) &&
          ts.isPropertyAccessExpression(node.initializer) &&
          node.initializer.name.text === "env" &&
          ts.isMetaProperty(node.initializer.expression)) {
        for (const element of node.name.elements) {
          if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
          const property = element.propertyName
            ? (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
                ? element.propertyName.text
                : undefined)
            : element.name.text;
          if (property) {
            fileOccurrences.push({
              name: property,
              node: element,
              alias: element.name.text,
              file,
              required: Boolean(element.initializer && ts.isNonNullExpression(element.initializer)),
              flag: isFlagName(property),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file.ast);

    // Track simple aliases such as const rawPort = process.env.PORT.
    const aliasVisit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
        const aliasName = node.name.text;
        const findAccesses = (initializer: ts.Node) => {
          const access = envAccess(initializer);
          if (access) {
            const occurrence = fileOccurrences.find((item) =>
              item.node.getStart() === access.access.getStart() &&
              item.node.getEnd() === access.access.getEnd(),
            );
            if (occurrence) occurrence.alias = aliasName;
          }
          ts.forEachChild(initializer, findAccesses);
        };
        findAccesses(node.initializer);
      }
      ts.forEachChild(node, aliasVisit);
    };
    aliasVisit(file.ast);

    // Only missing-value checks followed by a throw mark an environment name required.
    const validationVisit = (node: ts.Node) => {
      if (ts.isIfStatement(node) && hasThrow(node.thenStatement)) {
        for (const occurrence of fileOccurrences) {
          if (checksForMissingValue(node.expression, occurrence)) occurrence.required = true;
        }
      }
      if (ts.isBinaryExpression(node) &&
          (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
           node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
           node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
           node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)) {
        const leftValue = stringLiteral(node.left);
        const rightValue = stringLiteral(node.right);
        if (leftValue === "true" || leftValue === "false" ||
            rightValue === "true" || rightValue === "false") {
          for (const occurrence of fileOccurrences) {
            if (ts.isBindingElement(occurrence.node) && ts.isIdentifier(occurrence.node.name) &&
                (referencesIdentifier(node.left, occurrence.node.name.text) ||
                 referencesIdentifier(node.right, occurrence.node.name.text))) {
              occurrence.flag = true;
            }
          }
        }
      }
      ts.forEachChild(node, validationVisit);
    };
    validationVisit(file.ast);
    occurrences.push(...fileOccurrences);
  }

  const merged = new Map<string, { required: boolean; flag: boolean; locations: Set<string> }>();
  for (const occurrence of occurrences) {
    const value = merged.get(occurrence.name) ?? {
      required: false,
      flag: false,
      locations: new Set<string>(),
    };
    value.required ||= occurrence.required;
    value.flag ||= occurrence.flag;
    const line = occurrence.file.ast.getLineAndCharacterOfPosition(
      occurrence.node.getStart(),
    ).line + 1;
    value.locations.add(`${occurrence.file.relative}:${line}`);
    merged.set(occurrence.name, value);
  }
  return [...merged.entries()]
    .map(([name, value]) => ({
      name,
      required: value.required,
      flag: value.flag,
      locations: [...value.locations].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function collectTodos(files: TextFile[]): SourceSnapshot["todos"] {
  const todos: SourceSnapshot["todos"] = [];
  for (const file of files) {
    const lines = file.source.split(/\r?\n/);
    lines.forEach((text, index) => {
      const matches = text.match(/TODO|FIXME/gi);
      for (const _match of matches ?? []) {
        todos.push({ file: file.relative, line: index + 1, text: text.trim() });
      }
    });
  }
  return todos.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || a.text.localeCompare(b.text),
  );
}

export async function collectSource(root: string): Promise<SourceSnapshot> {
  const { files, textFiles } = await findSourceFiles(path.resolve(root));
  const routes = collectRoutes(files);
  return {
    routes,
    env: collectEnv(files),
    todos: collectTodos(textFiles),
  };
}
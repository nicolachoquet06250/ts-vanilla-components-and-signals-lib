#!/usr/bin/env node

// Simple TS components → Go Views generator
// Limitations: expressions are emitted as their source text strings; manual adaptation likely needed.
// It extracts html`...` tagged templates from exported functions or consts under src/components.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import {opendir} from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..');
const srcDir = path.join(repoRoot, 'src', 'components');
const goRoot = path.join(repoRoot, 'go');
const assetsDir = path.join(goRoot, 'assets');
const ssrDir = path.join(goRoot, 'ssr');
const outDir = path.join(ssrDir, 'components');

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// -------------------- CLI flags --------------------
const argv = process.argv.slice(2);
const FLAG_SCAFFOLD = argv.includes('--scaffold') || argv.includes('--init');
const FLAG_FORCE = argv.includes('--force');

// -------------------- Scaffolding helpers --------------------
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeFileIfMissing(filePath, content, { force = false } = {}) {
  if (fs.existsSync(filePath) && !force) {
    return false;
  }
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

// Generate the full Go project (module, core SSR, tests, server) if absent.
function scaffoldGoProject({ force = false } = {}) {
  ensureDir(goRoot);
  ensureDir(ssrDir);
  ensureDir(outDir);
  ensureDir(assetsDir);

  // go.mod for SSR module
  const gomodPath = path.join(ssrDir, 'go.mod');
  const gomod = 'module signals-ssr\n\n' + 'go 1.25\n';
  const w1 = writeFileIfMissing(gomodPath, gomod, { force });

  // ssr.go core (mirrors current behavior in repo)
  const ssrGoPath = path.join(ssrDir, 'ssr.scaffold.go');
  const ssrGo = `package ssr

import (
	"fmt"
	"reflect"
	"regexp"
	"strings"
)

// ---------- Types de base ----------

// DomSetup est gardé pour compatibilité conceptuelle,
// même si en SSR pur Go il n'est pas utilisé.
type DomSetup func(root any) func()

type VNode struct {
	HTML   string
	Setups []DomSetup
}

type View func() VNode

// ---------- Helpers type-check ----------

func isVNode(v any) bool {
	switch v.(type) {
	case VNode, *VNode:
		return true
	default:
		return false
	}
}

func asVNode(v any) VNode {
	switch vv := v.(type) {
	case VNode:
		return vv
	case *VNode:
		return *vv
	default:
		panic("asVNode: not a VNode")
	}
}

func isView(v any) bool {
	_, ok := v.(View)
	return ok
}

func asView(v any) View {
	if view, ok := v.(View); ok {
		return view
	}
	panic("asView: not a View")
}

// Interface pour les "Signal/Computed-like" (objets avec .Value()).
type valueLike interface {
	Value() any
}

// Petit helper pour appeler des fonctions 0-args / 1-out via reflect.
func callFuncNoArgs(fn any) (any, bool) {
	rv := reflect.ValueOf(fn)
	if rv.Kind() != reflect.Func {
		return nil, false
	}
	t := rv.Type()
	if t.NumIn() != 0 || t.NumOut() != 1 {
		return nil, false
	}
	out := rv.Call(nil)
	return out[0].Interface(), true
}

// ---------- Résolution scalaire ----------

func resolveScalar(v any) string {
	if v == nil {
		return ""
	}
	// false -> ""
	if b, ok := v.(bool); ok && !b {
		return ""
	}

	// View -> rendre le HTML de view()
	if isView(v) {
		vnode := asView(v)()
		return vnode.HTML
	}

	// VNode -> HTML direct
	if isVNode(v) {
		return asVNode(v).HTML
	}

	// Signal/Computed-like ({ Value() any })
	if vl, ok := v.(valueLike); ok {
		return resolveScalar(vl.Value())
	}

	// Fonction (factory, component sans props, etc.)
	if res, ok := callFuncNoArgs(v); ok {
		return resolveScalar(res)
	}

	// Tableau / slice : concatène le HTML/texte de chaque élément
	rv := reflect.ValueOf(v)
	kind := rv.Kind()
	if kind == reflect.Slice || kind == reflect.Array {
		var b strings.Builder
		for i := 0; i < rv.Len(); i++ {
			b.WriteString(resolveScalar(rv.Index(i).Interface()))
		}
		return b.String()
	}

	// Scalaire -> texte
	return fmt.Sprint(v)
}

// Résout une expression potentiellement réactive en { html, setups }.
// En SSR Go, setups sera toujours vide, mais on garde la structure.
type resolved struct {
	HTML   string
	Setups []DomSetup
}

func resolveToHTMLAndSetups(v any) resolved {
	if v == nil {
		return resolved{HTML: "", Setups: nil}
	}
	if b, ok := v.(bool); ok && !b {
		return resolved{HTML: "", Setups: nil}
	}

	// Signal/Computed-like
	if vl, ok := v.(valueLike); ok {
		return resolveToHTMLAndSetups(vl.Value())
	}

	// View
	if isView(v) {
		vnode := asView(v)()
		return resolved{HTML: vnode.HTML, Setups: append([]DomSetup{}, vnode.Setups...)}
	}

	// VNode
	if isVNode(v) {
		vnode := asVNode(v)
		return resolved{HTML: vnode.HTML, Setups: append([]DomSetup{}, vnode.Setups...)}
	}

	// Fonction
	if res, ok := callFuncNoArgs(v); ok {
		return resolveToHTMLAndSetups(res)
	}

	// Tableau / slice
	rv := reflect.ValueOf(v)
	kind := rv.Kind()
	if kind == reflect.Slice || kind == reflect.Array {
		var html strings.Builder
		var setups []DomSetup
		for i := 0; i < rv.Len(); i++ {
			r := resolveToHTMLAndSetups(rv.Index(i).Interface())
			html.WriteString(r.HTML)
			if len(r.Setups) > 0 {
				setups = append(setups, r.Setups...)
			}
		}
		return resolved{HTML: html.String(), Setups: setups}
	}

	// Scalaire
	return resolved{HTML: fmt.Sprint(v), Setups: nil}
}

// ---------- html tag (version SSR uniquement) ----------

var partID int

var attrRegex = regexp.MustCompile(\`([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*["']?$\`)

// HTML est l'équivalent de la tag function \`html\` côté TypeScript,
// mais en Go on la représente comme : literals + interpolations.
func HTML(literals []string, values ...any) VNode {
	//return func() VNode {
	var out strings.Builder

	for i, s := range literals {
		out.WriteString(s)

		if i >= len(values) {
			continue
		}

		expr := values[i]

		// View / VNode direct
		if isView(expr) {
			vnode := asView(expr)()
			out.WriteString(vnode.HTML)
			continue
		}
		if isVNode(expr) {
			vnode := asVNode(expr)
			out.WriteString(vnode.HTML)
			continue
		}

		// Détection si on est dans un attribut (SSR)
		current := out.String()
		inTag := strings.LastIndex(current, "<") > strings.LastIndex(current, ">")
		inAttribute := false
		var attrName string

		if inTag {
			if m := attrRegex.FindStringSubmatch(current); m != nil {
				attrName = m[1]
				inAttribute = true
			}
		}

		if inAttribute {
			// Gestion des attributs en SSR pour correspondre à l'algo TypeScript
			// - Event handlers (onXxx): écrire un id stable "ev-part-{n}" et incrémenter
			// - Attributs normaux: imprimer la valeur résolue et incrémenter le compteur (même si l'id n'est pas utilisé en SSR)
			if strings.HasPrefix(strings.ToLower(attrName), "on") {
				id := fmt.Sprintf("ev-part-%d", partID)
				partID++
				out.WriteString(id)
			} else {
				partID++
				scalar := resolveScalar(expr)
				out.WriteString(scalar)
			}
			continue
		}

		// Texte (interpolation "normale") :
		// en SSR on wrappe dans les markers <!--s...--> ... <!--e...-->
		text := resolveScalar(expr)
		marker := fmt.Sprintf("text-part-%d", partID)
		partID++
		out.WriteString("<!--s" + marker + "-->")
		out.WriteString(text)
		out.WriteString("<!--e" + marker + "-->")
	}

	return VNode{
		HTML:   out.String(),
		Setups: nil, // en SSR Go on ne gère pas les setups DOM
	}
	//}
}

// ---------- SSR : RenderToString (HTML complet + markers) ----------

func RenderToString(compOrView any, props any) string {
	prevPartID := partID
	partID = 0
	defer func() { partID = prevPartID }()

	var view View

	switch v := compOrView.(type) {
	case View:
		view = v
	case Component[any]:
		view = v(props)
	case VNode:
		view = func() VNode { return v }
	default:
		panic("RenderToString: expected View or Component")
	}

	vnode := view()
	return vnode.HTML
}
`;
  const w2 = writeFileIfMissing(ssrGoPath, ssrGo, { force });

  // components.go API layer
  const compApiPath = path.join(ssrDir, 'components.scaffold.go');
  const compApi = `package ssr

// Component is a function taking props P and returning a View.
type Component[P any] func(P) View

// DefineComponent mirrors TS defineComponent
func DefineComponent[P any](setup func(P) View) Component[P] {
	return func(props P) View { return setup(props) }
}

// RenderComponentToString renders a Component with props to HTML.
func RenderComponentToString[P any](comp Component[P], props P) string {
	prevPart := partID
	partID = 0
	defer func() { partID = prevPart }()
	vnode := comp(props)()
	return vnode.HTML
}
`;
  const w3 = writeFileIfMissing(compApiPath, compApi, { force });

  // tests for SSR
  const ssrTestPath = path.join(ssrDir, 'ssr.scaffold_test.go');
  const ssrTest = `package ssr

import "testing"

func TestRender_TextMarkers(t *testing.T) {
	v := HTML([]string{"<p>", "</p>"}, "Hello")
	got := RenderToString(v, nil)
	want := "<p><!--stext-part-0-->Hello<!--etext-part-0--></p>"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestRender_AttrNormal(t *testing.T) {
	v := HTML([]string{"<img alt=\"", "\" src=\"/x.png\">"}, "Logo")
	got := RenderToString(v, nil)
	want := "<img alt=\"Logo\" src=\"/x.png\">"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestRender_EventAttrPlaceholder(t *testing.T) {
	v := HTML([]string{"<button onclick=\"", "\">Ok</button>"}, "ignored")
	got := RenderToString(v, nil)
	want := "<button onclick=\"ev-part-0\">Ok</button>"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestRender_NestedView(t *testing.T) {
	child := HTML([]string{"<em>", "</em>"}, "x")
	parent := HTML([]string{"<p>", "</p>"}, child)
	got := RenderToString(parent, nil)
	want := "<p><em><!--stext-part-0-->x<!--etext-part-0--></em></p>"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestRender_ArrayScalar(t *testing.T) {
	v := HTML([]string{"<ul>", "</ul>"}, []any{
		HTML([]string{"<li>", "</li>"}, "a"),
		HTML([]string{"<li>", "</li>"}, "b"),
	})
	got := RenderToString(v, nil)
	want := "<ul><!--stext-part-0--><li><!--stext-part-1-->a<!--etext-part-1--></li><li><!--stext-part-2-->b<!--etext-part-2--></li><!--etext-part-0--></ul>"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
`;
  const w4 = writeFileIfMissing(ssrTestPath, ssrTest, { force });

  // components_test.go for API
  const compTestPath = path.join(ssrDir, 'components.scaffold_test.go');
  const compTest = `package ssr

import "testing"

type titleProps struct{ Title string }

func TestRenderComponentToString_Simple(t *testing.T) {
	comp := DefineComponent(func(p titleProps) View { return HTML([]string{"<h1>", "</h1>"}, p.Title) })
	got := RenderComponentToString(comp, titleProps{Title: "Hello"})
	want := "<h1><!--stext-part-0-->Hello<!--etext-part-0--></h1>"
	if got != want { t.Fatalf("got %q want %q", got, want) }
}

func TestRenderComponentToString_EventAttrPlaceholder(t *testing.T) {
	comp := DefineComponent(func(p struct{}) View { return HTML([]string{"<button onclick=\"","\">Ok</button>"}, "ignored") })
	got := RenderComponentToString(comp, struct{}{})
	want := "<button onclick=\"ev-part-0\">Ok</button>"
	if got != want { t.Fatalf("got %q want %q", got, want) }
}`;
  const w5 = writeFileIfMissing(compTestPath, compTest, { force });

  // go/server.go using stdlib http
  const serverPath = path.join(goRoot, 'server.go');
  const serverGo = `package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"

	ssr "signals-ssr"
	"signals-ssr/components"
)

type Manifest map[string]struct {
	File    string   \`json:"file"\`
	Name    string   \`json:"name"\`
	Source  string   \`json:"src"\`
	IsEntry bool     \`json:"isEntry"\`
	CSS     []string \`json:"css"\`
}

var port = flag.Int("port", 0, "port du server")

func main() {
	flag.Parse()

	mux := http.NewServeMux()

	var manifest, err = os.ReadFile("../dist/.vite/manifest.json")
	if err != nil {
		log.Fatal(err)
	}

	var decoded Manifest

	_ = json.Unmarshal(manifest, &decoded)

	// Routes API simples (exemple)
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(\`{"status":"ok"}\`))
	})

	mux.HandleFunc("/assets/{path...}", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		_, err := os.Stat("../dist/" + path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, "../dist/"+path)
	})

	// Page d’accueil: SSR de la vue App générée
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" { // ne répondre que pour la racine
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")

		// App() est générée par scripts/ts2go.js dans signals-ssr/components
		view := components.AppWithProps(components.AppProps{Client: false})
		appHTML := ssr.RenderToString(view, nil)

		css := func() string {
			var css string
			for _, file := range decoded["src/entry-client.ts"].CSS {
				css += fmt.Sprintf(\`<link rel="stylesheet" href="%s">\`, file)
			}
			return css
		}()
		script := decoded["src/entry-client.ts"].File

		// Gabarit HTML minimal; vous pouvez y ajouter vos scripts d’hydratation si besoin
		page := fmt.Sprintf(\`<!doctype html>
		<html lang="fr">
		<head>
		  <meta charset="utf-8">
		  <meta name="viewport" content="width=device-width, initial-scale=1" />
		  <title>signals SSR + mux</title>
		  <link rel="icon" href="/favicon.ico">
		  %s
		</head>
		<body>
		  <div id="app">%s</div>
		  <script async src="%s"></script>
		</body>
		</html>\`, css, appHTML, script)

		println(appHTML)

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(page))
	})

	// Fichiers statiques depuis ./public (dans la racine du repo)
	// Exposés sous /static/* pour éviter les collisions de routes
	// Chemin relatif depuis go/server.go → ../public
	//static := http.StripPrefix("/static/", http.FileServer(http.Dir("../public")))
	//mux.Handle("/static/", static)

	addr := ":" + strconv.Itoa(*port)
	log.Printf("listening on %s (net/http ServeMux)", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
`;
  const w6 = writeFileIfMissing(serverPath, serverGo, { force });

  const wrote = [w1, w2, w3, w4, w5, w6].some(Boolean);
  if (wrote) {
    console.log('[ts2go] Go project scaffolded' + (force ? ' (force)' : ''));
  } else {
    console.log('[ts2go] Go project already present (use --force to overwrite)');
  }
}

// Collect image imports and embed them as data URLs
// Returns a map: identifier -> { varName, dataUrl }
function collectImageImports(sf) {
  /** @type {Record<string, {varName:string, dataUrl:string}>} */
  const assets = {};
  const exts = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);
  const mimeByExt = {
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
  };

  const resolvePath = (spec) => {
    try {
      if (spec.startsWith('/')) {
        // Absolute from repo root
        const pRoot = path.join(repoRoot, spec.slice(1));
        if (fs.existsSync(pRoot)) return pRoot;
        const pPublic = path.join(repoRoot, 'public', spec.slice(1));
        if (fs.existsSync(pPublic)) return pPublic;
        const pSrc = path.join(repoRoot, 'src', spec.slice(1));
        if (fs.existsSync(pSrc)) return pSrc;
        return pRoot;
      }
      const base = path.dirname(sf.fileName);
      const rel = path.resolve(base, spec);
      if (fs.existsSync(rel)) return rel;
      const fromSrc = path.resolve(path.join(repoRoot, 'src'), spec);
      if (fs.existsSync(fromSrc)) return fromSrc;
      return rel;
    } catch {
      return spec;
    }
  };

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const ext = path.extname(spec).toLowerCase();
      if (!exts.has(ext)) continue;
      const def = st.importClause.name && st.importClause.name.text;
      if (!def) continue; // only default imports for images
      const abs = resolvePath(spec);
      if (!fs.existsSync(abs)) {
        console.warn(`[ts2go] image not found: ${spec} (resolved: ${abs}) in ${sf.fileName}`);
        continue;
      }
      try {
        const bytes = fs.readFileSync(abs);
        const b64 = Buffer.from(bytes).toString('base64');
        const mime = mimeByExt[ext] || 'application/octet-stream';
        const dataUrl = `data:${mime};base64,${b64}`;
        assets[def] = { varName: def, dataUrl };
      } catch (e) {
        console.warn(`[ts2go] failed to embed image ${abs}:`, e?.message || e);
      }
    }
  }
  return assets;
}

/** @param {ts.SourceFile} sf */
function generateForFile(sf) {
  /** @type {Array<{name:string, template:ts.TaggedTemplateExpression, propsInfo:any}>} */
  const found = [];
  const assetMap = collectImageImports(sf);

  function visit(node) {
    // export function Name(...) { return html`...`; }
    if (ts.isFunctionDeclaration(node) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) && node.body) {
      const ret = node.body.statements.find(st => ts.isReturnStatement(st));
      if (ret && ret.expression && ts.isTaggedTemplateExpression(ret.expression) && ts.isIdentifier(ret.expression.tag) && ret.expression.tag.text === 'html') {
        const name = node.name?.text || 'View';
        const propsInfo = analyzeProps(node.parameters?.[0], ret.expression, sf);
        const initials = collectInitialsFromBlock(node.body, sf);
        found.push({ name, template: ret.expression, propsInfo, initials });
      }
    }
    // export const Name = ... html`...`
    if (ts.isVariableStatement(node) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const init = decl.initializer;
          if (ts.isTaggedTemplateExpression(init) && ts.isIdentifier(init.tag) && init.tag.text === 'html') {
            const propsInfo = analyzeProps(undefined, init, sf);
            const initials = collectInitialsFromBlock(undefined, sf);
            found.push({ name: decl.name.text, template: init, propsInfo, initials });
          }
          // export const X = defineComponent(... => html`...`)
          if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'defineComponent') {
            const cb = init.arguments[0];
            if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && ts.isBlock(cb.body)) {
              const ret = cb.body.statements.find(st => ts.isReturnStatement(st));
              if (ret && ret.expression && ts.isTaggedTemplateExpression(ret.expression) && ts.isIdentifier(ret.expression.tag) && ret.expression.tag.text === 'html') {
                const propsInfo = analyzeProps(cb.parameters?.[0], ret.expression, sf);
                const initials = collectInitialsFromBlock(cb.body, sf);
                found.push({ name: decl.name.text, template: ret.expression, propsInfo, initials });
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);

  if (!found.length) return [];

  const outputs = [];
  for (const { name, template, propsInfo, initials } of found) {
    const { parts, values } = extractTemplate(template, sf);
    const go = emitGo(name, parts, values, sf.fileName, sf, propsInfo, assetMap, initials);
    outputs.push({ name, code: go });
  }
  return outputs;
}

function extractTemplate(tagged, sf) {
  const tpl = tagged.template;
  if (!ts.isNoSubstitutionTemplateLiteral(tpl) && !ts.isTemplateExpression(tpl) && !ts.isTemplateLiteral(tpl)) {
    return { parts: [tpl.getText(sf)], values: [] };
  }
  if (ts.isNoSubstitutionTemplateLiteral(tpl)) {
    return { parts: [tpl.text], values: [] };
  }
  // TemplateExpression: head + spans
  const parts = [tpl.head.text];
  const values = [];
  for (const span of tpl.templateSpans) {
    // Keep the AST node for smarter emission later (components mapping)
    values.push(span.expression);
    parts.push(span.literal.text);
  }
  return { parts, values };
}

function goStringLiteral(s) {
  return JSON.stringify(s).replace(/[\u2028\u2029]/g, (m) => m === '\u2028' ? '\\u2028' : '\\u2029');
}

function emitGo(name, parts, values, srcPath, sf, propsInfo, assetMap = {}, initials = undefined) {
  const pkg = 'components';
  const header = `// Code generated by scripts/ts2go.js from ${path.relative(process.cwd(), srcPath)}; DO NOT EDIT.\n`;
  const imports = `package ${pkg}\n\nimport ssr \"signals-ssr\"\n`;
  const partsArr = '[]string{' + parts.map(p => goStringLiteral(p)).join(', ') + '}';
  const ctx = buildCtx(name, propsInfo, sf, assetMap, initials);
  // Mark that we are at top-level interpolations; collect component pre-executions
  ctx.__compStmts = [];
  ctx.__compSeq = 0;
  ctx.__topLevel = true;
  const valsArr = values.map(v => toGoValue(v, sf, ctx)).join(', ');

  const code = [];
  code.push(header);
  code.push(imports);

  // Emit embedded assets as Go consts (string data URLs)
  const assetKeys = Object.keys(assetMap || {});
  if (assetKeys.length) {
    code.push('const (');
    for (const k of assetKeys) {
      const a = assetMap[k];
      code.push(`\n\t${a.varName} = ${goStringLiteral(a.dataUrl)}`);
    }
    code.push('\n)\n\n');
  }

  // Emit props struct if any
  if (ctx.fields && ctx.fields.length) {
    code.push(`type ${ctx.propsType} struct {`);
    for (const f of ctx.fields) {
      code.push(`\n\t${f} any`);
    }
    code.push(`\n}\n`);
  } else {
    // still declare empty struct for consistency
    code.push(`type ${ctx.propsType} struct {}` + "\n\n");
  }

  // Wrapper without props kept for backward compatibility
  code.push(`// ${name} is a generated View from a TS html template.`);
  code.push(`\nfunc ${name}() ssr.View {`);
  code.push(`\n\treturn ${name}WithProps(${ctx.propsType}{})`);
  code.push(`\n}\n`);

  // Main function taking props
  code.push(`func ${name}WithProps(props ${ctx.propsType}) ssr.View {`);
  // Insert pre-execution of nested components to ensure their IDs are incremented first
  if (ctx.__compStmts && ctx.__compStmts.length) {
    for (const st of ctx.__compStmts) {
      code.push(`\n\t${st}`);
    }
  }
  code.push(`\n\treturn ssr.HTML(${partsArr}${values.length ? ', ' + valsArr : ''})`);
  code.push(`\n}\n`);
  return code.join('');
}

// Heuristics for expressions inside html templates:
// - If it looks like a component (PascalCase identifier or call), emit a Go call Name()
//   so it composes as a nested View.
// - Otherwise, emit the TS source as a Go string literal so the Go SSR treats it as text.
function toGoValue(expr, sf, ctx = undefined) {
  const isPascal = (n) => /^[A-Z][A-Za-z0-9_]*$/.test(n || '');
  const pascal = (s) => (s||'').replace(/^[a-z]/, c => c.toUpperCase()).replace(/[_-](\w)/g, (_,c)=>c.toUpperCase());
  const preExecComponent = (callCode) => {
    // Only pre-exec at top-level slots to avoid scoping issues inside IIFEs/loops
    if (ctx && ctx.__topLevel) {
      const varName = `__c${ctx.__compSeq++}`;
      ctx.__compStmts.push(`${varName} := ${callCode}`);
      return varName;
    }
    return callCode;
  };
  const unwrap = (e) => {
    while (
      e && (
        ts.isParenthesizedExpression(e) ||
        ts.isAsExpression(e) ||
        ts.isTypeAssertionExpression(e) ||
        ts.isNonNullExpression(e) ||
        ts.isSatisfiesExpression?.(e)
      )
    ) {
      e = e.expression;
    }
    return e;
  };
  try {
    expr = unwrap(expr);
    // Plain string literals: emit their text content as a proper Go string literal
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return goStringLiteral(expr.text);
    }
    // If identifier matches a local loop variable or similar, emit as-is
    if (ctx && ts.isIdentifier(expr) && ctx.locals && ctx.locals.has(expr.text)) {
      return expr.text;
    }
    // Replace identifiers that are known signals/computed with their initial Go literal
    if (ctx && ts.isIdentifier(expr) && ctx.initials && ctx.initials[expr.text] != null) {
      return ctx.initials[expr.text];
    }
    // Replace calls like name() when name is a known signal/computed
    if (ctx && ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && ctx.initials && ctx.initials[expr.expression.text] != null) {
      return ctx.initials[expr.expression.text];
    }
    // Handle ternary expressions: cond ? a : b → IIFE with if/else in Go
    if (ts.isConditionalExpression(expr)) {
      const subCtx = ctx ? { ...ctx, __topLevel: false } : ctx;
      const whenTrueGo = toGoValue(expr.whenTrue, sf, subCtx);
      const whenFalseGo = toGoValue(expr.whenFalse, sf, subCtx);
      // We cannot safely emit the TS condition as Go; use a placeholder and keep structure.
      return `(func() any { if false { return ${whenTrueGo} } else { return ${whenFalseGo} } })()`;
    }
    // Handle Array.map(...) patterns, e.g., signal.map(t => Component(props))
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name?.text === 'map') {
      const arrayExpr = expr.expression.expression; // the object before .map
      const mapper = expr.arguments?.[0];
      if (mapper && (ts.isArrowFunction(mapper) || ts.isFunctionExpression(mapper))) {
        // Determine param identifier to expose as local
        let loopVar = 'it';
        if (mapper.parameters && mapper.parameters.length > 0) {
          const p0 = mapper.parameters[0];
          if (ts.isIdentifier(p0.name)) loopVar = p0.name.text;
        }
        // Build a child context with the loop variable registered as a local symbol
        const childCtx = { ...ctx, locals: new Set([...(ctx?.locals || []), loopVar]), __topLevel: false };
        // Determine body expression of the mapper
        let bodyExpr = undefined;
        if (ts.isBlock(mapper.body)) {
          const ret = mapper.body.statements.find(s => ts.isReturnStatement(s));
          if (ret && ret.expression) bodyExpr = ret.expression;
        } else {
          bodyExpr = mapper.body;
        }
        const arrGo = toGoValue(arrayExpr, sf, ctx);
        const valGo = bodyExpr ? toGoValue(bodyExpr, sf, childCtx) : 'nil';
        // Emit an IIFE that ranges over the slice and builds []any
        return `(func() []any { var __out []any; for _, ${loopVar} := range ${arrGo} { __out = append(__out, ${valGo}) }; return __out })()`;
      }
    }
    // props.property
    if (ctx && ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === ctx.propsIdent) {
      const field = pascal(expr.name.text);
      return `props.${field}`;
    }
    // destructured alias identifier
    if (ctx && ts.isIdentifier(expr) && ctx.aliasToField && ctx.aliasToField[expr.text]) {
      const field = ctx.aliasToField[expr.text];
      return `props.${field}`;
    }
    if (ts.isCallExpression(expr)) {
      const callee = unwrap(expr.expression);
      if (ts.isIdentifier(callee)) {
        const name = callee.text;
        if (isPascal(name)) {
          const first = expr.arguments?.[0];
          if (first && ts.isObjectLiteralExpression(first)) {
            const lit = toGoPropsLiteral(name, first, sf, ctx);
            return preExecComponent(`${name}WithProps(${lit})`);
          }
          return preExecComponent(`${name}()`);
        }
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const id = callee.name && callee.name.text;
        if (isPascal(id)) return preExecComponent(`${id}()`);
      }
    }
    if (ts.isIdentifier(expr)) {
      const name = expr.text;
      // Prefer asset constant if available
      if (ctx && ctx.assetIdents && ctx.assetIdents.has && ctx.assetIdents.has(name)) {
        return name;
      }
      if (isPascal(name)) return preExecComponent(`${name}()`);
    }
  } catch {}
  const src = expr && typeof expr.getText === 'function' ? expr.getText(sf) : String(expr);
  return goStringLiteral(src);
}

function buildCtx(name, propsInfo, sf, assetMap = {}, initials = undefined) {
  const pascal = (s) => (s||'').replace(/^[a-z]/, c => c.toUpperCase()).replace(/[_-](\w)/g, (_,c)=>c.toUpperCase());
  const ctx = { propsType: `${name}Props`, propsIdent: 'props', fields: [], aliasToField: {}, assetIdents: new Set(Object.keys(assetMap || {})), initials: initials || {}, locals: new Set() };
  if (!propsInfo) return ctx;
  if (propsInfo.kind === 'identifier') {
    ctx.propsIdent = propsInfo.name;
    const uniq = new Set();
    for (const f of propsInfo.fields || []) uniq.add(pascal(f));
    ctx.fields = Array.from(uniq);
  } else if (propsInfo.kind === 'object') {
    const uniq = new Set();
    for (const item of propsInfo.elements || []) {
      const field = pascal(item.prop || item.name);
      uniq.add(field);
      ctx.aliasToField[item.name] = field;
    }
    ctx.fields = Array.from(uniq);
  }
  return ctx;
}

function analyzeProps(paramNode, template, sf) {
  if (!paramNode) return undefined;
  if (ts.isIdentifier(paramNode.name)) {
    const name = paramNode.name.text;
    const fields = collectPropFieldsFromTemplate(name, template, sf);
    return { kind: 'identifier', name, fields };
  }
  if (ts.isObjectBindingPattern(paramNode.name)) {
    const elements = paramNode.name.elements.map(el => ({
      name: ts.isIdentifier(el.name) ? el.name.text : 'prop',
      prop: el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : (ts.isIdentifier(el.name) ? el.name.text : 'prop')
    }));
    return { kind: 'object', elements };
  }
  return undefined;
}

// ---- Signals/computed initials collection ----
function collectInitialsFromBlock(block, sf) {
  /** @type {Record<string,string>} */
  const initials = {};
  if (!block || !block.statements) return initials;

  // Helper evaluators
  const toNumber = (s) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };

  function evalLiteral(node) {
    node = unwrapNode(node);
    if (!node) return { ok: false };
    if (ts.isNumericLiteral(node)) return { ok: true, code: node.text };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, code: 'true' };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, code: 'false' };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { ok: true, code: goStringLiteral(node.text) };
    if (ts.isArrayLiteralExpression(node)) return { ok: true, code: '[]any{}' };
    if (ts.isParenthesizedExpression(node)) return evalLiteral(node.expression);
    if (ts.isPrefixUnaryExpression(node)) {
      const r = evalLiteral(node.operand);
      if (!r.ok) return r;
      const n = toNumber(r.code);
      if (n == null) return { ok: false };
      return { ok: true, code: String(node.operator === ts.SyntaxKind.MinusToken ? -n : n) };
    }
    if (ts.isBinaryExpression(node)) {
      const L = evalLiteral(node.left);
      const R = evalLiteral(node.right);
      if (!L.ok || !R.ok) return { ok: false };
      const ln = toNumber(L.code), rn = toNumber(R.code);
      if (ln != null && rn != null) {
        switch (node.operatorToken.kind) {
          case ts.SyntaxKind.PlusToken: return { ok: true, code: String(ln + rn) };
          case ts.SyntaxKind.MinusToken: return { ok: true, code: String(ln - rn) };
          case ts.SyntaxKind.AsteriskToken: return { ok: true, code: String(ln * rn) };
          case ts.SyntaxKind.SlashToken: return { ok: true, code: String(ln / rn) };
          case ts.SyntaxKind.PercentToken: return { ok: true, code: String(ln % rn) };
        }
      }
      return { ok: false };
    }
    if (ts.isIdentifier(node) && initials[node.text] != null) {
      return { ok: true, code: initials[node.text] };
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && initials[node.expression.text] != null) {
      // Accessor call like count() → initial value
      return { ok: true, code: initials[node.expression.text] };
    }
    return { ok: false };
  }

  function unwrapNode(e) {
    while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression?.(e))) {
      e = e.expression;
    }
    return e;
  }

  for (const st of block.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const decl of st.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const id = decl.name.text;
      const init = decl.initializer;
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
        const callee = init.expression.text;
        if (callee === 'signal') {
          const arg = init.arguments?.[0];
          if (!arg) { initials[id] = 'nil'; continue; }
          const r = evalLiteral(arg);
          initials[id] = r.ok ? r.code : goStringLiteral(arg.getText(sf));
        } else if (callee === 'computed') {
          const fn = init.arguments?.[0];
          let bodyExpr = undefined;
          if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
            if (ts.isBlock(fn.body)) {
              const ret = fn.body.statements.find(s => ts.isReturnStatement(s));
              if (ret && ret.expression) bodyExpr = ret.expression;
            } else {
              bodyExpr = fn.body;
            }
          }
          if (bodyExpr) {
            const r = evalLiteral(bodyExpr);
            initials[id] = r.ok ? r.code : goStringLiteral(bodyExpr.getText(sf));
          }
        }
      }
    }
  }
  return initials;
}

function collectPropFieldsFromTemplate(propsIdent, template, sf) {
  const fields = new Set();
  const tpl = template.template;
  if (ts.isTemplateExpression(tpl)) {
    for (const span of tpl.templateSpans) {
      const expr = span.expression;
      collect(expr);
    }
  }
  function collect(expr) {
    try {
      if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === propsIdent) {
        fields.add(expr.name.text);
      } else if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) {
        collect(expr.expression);
      } else if (ts.isConditionalExpression(expr)) {
        collect(expr.whenTrue); collect(expr.whenFalse);
      } else if (ts.isCallExpression(expr)) {
        for (const a of expr.arguments) collect(a);
      }
    } catch {}
  }
  return Array.from(fields);
}

function toGoPropsLiteral(name, objLit, sf, ctx) {
  const pascal = (s) => (s||'').replace(/^[a-z]/, c => c.toUpperCase()).replace(/[_-](\w)/g, (_,c)=>c.toUpperCase());
  const fields = [];
  for (const prop of objLit.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const key = ts.isIdentifier(prop.name) ? prop.name.text : prop.name.getText(sf);
      const field = pascal(key);
      const val = toGoValue(prop.initializer, sf, ctx);
      fields.push(`${field}: ${val}`);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      const key = prop.name.text;
      const field = pascal(key);
      const val = toGoValue(prop.name, sf, ctx);
      fields.push(`${field}: ${val}`);
    }
  }
  return `${name}Props{ ${fields.join(', ')} }`;
}

async function run() {
  // Optionally scaffold the Go project first
  if (FLAG_SCAFFOLD) {
    scaffoldGoProject({ force: FLAG_FORCE });
  } else {
    // Auto-scaffold minimal dirs if missing (no overwrite)
    if (!fs.existsSync(path.join(ssrDir, 'go.mod'))) {
      scaffoldGoProject({ force: false });
    }
  }
  const files = fs
    .readdirSync(srcDir)
    .filter(f => f.endsWith('.ts'))
    // ensure that *.new.ts(x) are processed last so they override older outputs
    .sort((a, b) => {
      const anew = a.includes('.new.');
      const bnew = b.includes('.new.');
      if (anew === bnew) return a.localeCompare(b);
      return anew ? 1 : -1;
    });
  for (const f of files) {
    const full = path.join(srcDir, f);
    const code = fs.readFileSync(full, 'utf8');
    const sf = ts.createSourceFile(full, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const outs = generateForFile(sf);
    if (!outs.length) continue;
    for (const o of outs) {
      const outFile = path.join(outDir, o.name.toLowerCase() + '.go');
      fs.writeFileSync(outFile, o.code, 'utf8');
      console.log('Generated', path.relative(repoRoot, outFile));
    }
  }

  console.log('');

  const dir = await opendir(__dirname + '/../dist/assets');
  for await (const entry of dir) {
      fs.copyFileSync(path.join(__dirname, '../dist/assets', entry.name), path.join(assetsDir, entry.name));
      console.log('Copied from', path.join(__dirname, '../dist/assets', entry.name), 'to', path.join(assetsDir, entry.name));
  }
}

run();

package ssr

import (
	"fmt"
	"reflect"
	"regexp"
	"strconv"
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

var attrRegex = regexp.MustCompile(`([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*["']?$`)

// HTML est l'équivalent de la tag function `html` côté TypeScript,
// mais en Go on la représente comme : literals + interpolations.
func HTML(literals []string, values ...any) View {
	return func() VNode {
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

			if inTag {
				if m := attrRegex.FindStringSubmatch(current); m != nil {
					// attrName := m[1] // pas utilisé en SSR, mais on peut le garder si besoin
					_ = m[1]
					inAttribute = true
				}
			}

			if inAttribute {
				// Attribut "normal" en SSR : on imprime simplement la valeur résolue
				if strings.Contains(literals[i], "on") {
					partID = 0
					partID++
					out.WriteString("ev-part-" + strconv.Itoa(partID))
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
	}
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
	default:
		panic("RenderToString: expected View or Component")
	}

	vnode := view()
	return vnode.HTML
}

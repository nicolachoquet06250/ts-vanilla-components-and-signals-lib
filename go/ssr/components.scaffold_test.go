package ssr

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
}
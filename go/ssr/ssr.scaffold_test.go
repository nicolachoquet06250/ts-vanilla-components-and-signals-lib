package ssr

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

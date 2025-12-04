package ssr

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

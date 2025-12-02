import type { Plugin } from 'vite';
import { parse } from '@babel/parser';
import trav from '@babel/traverse';
import { generate } from '@babel/generator';
import * as t from '@babel/types';

export interface AutoComponentsOptions {
    /**
     * Chemin du module qui exporte `defineComponent`
     * relatif au fichier transformé.
     * Exemple: "./components"
     */
    componentsModule?: string;
}

export const autoComponentsPlugin = (
    options: AutoComponentsOptions = {},
): Plugin => ({
    name: 'vite-plugin-auto-components',
    enforce: 'pre',

    transform(code, id) {
        // Ne traiter que les fichiers au format ".new.ts"
        if (!id.endsWith('.ts')) return null;
        // on évite de transformer le fichier des composants lui-même
        if (id.includes('components.ts')) return null;

        const ast = parse(code, {
            sourceType: 'module',
            plugins: ['typescript'],
        });
        console.log(id, ast)

        let changed = false;
        let hasDefineImport = false;
        // Module cible pour importer defineComponent. On part des options,
        // mais si on voit un import de { html } on réutilise son module.
        let targetComponentsModule = options.componentsModule ?? './components';

        // 1. vérifier s'il y a déjà un import defineComponent
        // @ts-ignore
        const traverse = trav.default;
        traverse(ast, {
            ImportDeclaration(path: any) {
                const source = path.node.source.value as string;

                // S'il y a un import de { html }, mémorise ce module comme cible
                const hasHtml = path.node.specifiers.some(
                    (s: any) => t.isImportSpecifier(s) && t.isIdentifier(s.imported, { name: 'html' }),
                );
                if (hasHtml) {
                    targetComponentsModule = source;
                }

                // Si defineComponent est déjà importé, on le note
                const hasDefine = path.node.specifiers.some(
                    (s: any) => t.isImportSpecifier(s) && t.isIdentifier(s.imported, { name: 'defineComponent' }),
                );
                if (hasDefine) hasDefineImport = true;
            },
        });

        traverse(ast, {
            // Deux formes supportées:
            // A) export function Foo(...) { return html`...`; }
            // B) export function Foo(...) { return () => html`...`; }
            ExportNamedDeclaration(path: any) {
                const decl = path.node.declaration;
                if (!decl || !t.isFunctionDeclaration(decl) || !decl.id) return;

                const originalName = decl.id.name;
                if (!/^[A-Z]/.test(originalName)) return; // composant = nom qui commence par maj

                // Helpers de détection
                const isHtmlTagged = (n: any) =>
                    t.isTaggedTemplateExpression(n) && t.isIdentifier(n.tag, { name: 'html' });

                const fnReturnsHtmlDirect = () => {
                    let direct = false;
                    path.traverse({
                        ReturnStatement(rPath: any) {
                            const arg = rPath.node.argument;
                            if (isHtmlTagged(arg)) direct = true;
                        },
                    });
                    return direct;
                };

                const fnReturnsViewThatReturnsHtml = () => {
                    let matched = false;
                    path.traverse({
                        ReturnStatement(rPath: any) {
                            const arg = rPath.node.argument as any;
                            if (!arg) return;
                            if (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg)) {
                                // body peut être un template tag html directement, ou un block avec return html`...`
                                const body: any = arg.body;
                                if (isHtmlTagged(body)) {
                                    matched = true;
                                    return;
                                }
                                if (t.isBlockStatement(body)) {
                                    for (const st of body.body) {
                                        if (t.isReturnStatement(st) && st.argument && isHtmlTagged(st.argument)) {
                                            matched = true;
                                            return;
                                        }
                                    }
                                }
                            }
                        },
                    });
                    return matched;
                };

                const usesDirectHtml = fnReturnsHtmlDirect();
                const usesSetupReturningView = !usesDirectHtml && fnReturnsViewThatReturnsHtml();

                if (!usesDirectHtml && !usesSetupReturningView) return;

                changed = true;

                if (usesDirectHtml) {
                    const viewName = `${originalName}View`;
                    // 1) on renomme la fonction originale -> FooView
                    decl.id = t.identifier(viewName);
                    // On conserve les paramètres de la fonction originale (props, etc.)
                    const params = decl.params;
                    // 2) crée: export const Foo = defineComponent((props) => () => FooView(props));
                    const wrapperComponent = t.exportNamedDeclaration(
                        t.variableDeclaration('const', [
                            t.variableDeclarator(
                                t.identifier(originalName),
                                t.callExpression(t.identifier('defineComponent'), [
                                    t.arrowFunctionExpression(
                                        params,
                                        t.arrowFunctionExpression(
                                            [],
                                            t.callExpression(
                                                t.identifier(viewName),
                                                params.map(p => (t.isIdentifier(p) ? t.identifier(p.name) : (p as any)))
                                            ),
                                        ),
                                    ),
                                ]),
                            ),
                        ]),
                        [],
                    );
                    path.replaceWithMultiple([decl, wrapperComponent]);
                    return;
                }

                if (usesSetupReturningView) {
                    // La fonction exportée est déjà un setup qui retourne une View.
                    // On la renomme en FooSetup et on exporte const Foo = defineComponent(FooSetup)
                    const setupName = `${originalName}Setup`;
                    decl.id = t.identifier(setupName);
                    const wrapper = t.exportNamedDeclaration(
                        t.variableDeclaration('const', [
                            t.variableDeclarator(
                                t.identifier(originalName),
                                t.callExpression(t.identifier('defineComponent'), [
                                    t.identifier(setupName),
                                ]),
                            ),
                        ]),
                        [],
                    );
                    path.replaceWithMultiple([decl, wrapper]);
                }
            },
        });

        // 2. si on a ajouté des components, s'assurer qu'on importe defineComponent
        if (changed && !hasDefineImport) {
            const importDecl = t.importDeclaration(
                [t.importSpecifier(t.identifier('defineComponent'), t.identifier('defineComponent'))],
                t.stringLiteral(targetComponentsModule),
            );
            (ast.program.body as any).unshift(importDecl);
        }

        if (!changed) return null;

        const out = generate(ast, { decoratorsBeforeExport: true }, code);
        return {
            code: out.code,
            map: out.map,
        };
    },
})

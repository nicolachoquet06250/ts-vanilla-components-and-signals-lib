// vite-plugin-autocomponents.ts
import type { Plugin } from 'vite';
import { parse } from '@babel/parser';
import trav from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';

export interface AutoComponentsOptions {
    /**
     * Chemin du module qui exporte `defineComponent`
     * relatif au fichier transformé.
     * Exemple: "./components"
     */
    componentsModule?: string;
}

export default function autoComponentsPlugin(
    options: AutoComponentsOptions = {},
): Plugin {
    const componentsModule = options.componentsModule ?? './components';

    return {
        name: 'vite-plugin-auto-components',
        enforce: 'pre',

        transform(code, id) {
            if (!id.endsWith('.ts') && !id.endsWith('.tsx')) return null;
            // on évite de transformer le fichier des composants lui-même
            if (id.includes('components.ts')) return null;

            const ast = parse(code, {
                sourceType: 'module',
                plugins: ['typescript'],
            });
            console.log(id, ast)

            let changed = false;
            let hasDefineImport = false;

            // 1. vérifier s'il y a déjà un import defineComponent
            // @ts-ignore
            const traverse = trav.default;
            traverse(ast, {
                ImportDeclaration(path: any) {
                    const source = path.node.source.value;
                    if (source === componentsModule) {
                        const spec = path.node.specifiers.find(
                            (s: any) =>
                                t.isImportSpecifier(s) &&
                                t.isIdentifier(s.imported, { name: 'defineComponent' }),
                        );
                        if (spec) hasDefineImport = true;
                    }
                },
            });

            traverse(ast, {
                // On cible: export function Foo(...) { ... return html`...`; }
                ExportNamedDeclaration(path: any) {
                    const decl = path.node.declaration;
                    if (!decl || !t.isFunctionDeclaration(decl) || !decl.id) return;

                    const originalName = decl.id.name;
                    if (!/^[A-Z]/.test(originalName)) return; // composant = nom qui commence par maj

                    // On vérifie qu'il y a bien un `return html` dans la fonction
                    let usesHtml = false;
                    path.traverse({
                        ReturnStatement(rPath: any) {
                            const arg = rPath.node.argument;
                            if (
                                t.isTaggedTemplateExpression(arg) &&
                                t.isIdentifier(arg.tag, { name: 'html' })
                            ) {
                                usesHtml = true;
                            }
                        },
                    });
                    if (!usesHtml) return;

                    changed = true;

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
                                            t.callExpression(t.identifier(viewName), params.map(p => {
                                                // on réutilise les mêmes identifiants de paramètres dans l'appel
                                                if (t.isIdentifier(p)) return t.identifier(p.name);
                                                // cas un peu plus complexes (destructuring) -> on passe tel quel
                                                return p as any;
                                            })),
                                        ),
                                    ),
                                ]),
                            ),
                        ]),
                        [],
                    );

                    // 3) on remplace l'export original par:
                    //    function FooView(...) {...}
                    //    export const Foo = defineComponent(...)
                    path.replaceWithMultiple([decl, wrapperComponent]);
                },
            });

            // 2. si on a ajouté des components, s'assurer qu'on importe defineComponent
            if (changed && !hasDefineImport) {
                const importDecl = t.importDeclaration(
                    [t.importSpecifier(t.identifier('defineComponent'), t.identifier('defineComponent'))],
                    t.stringLiteral(componentsModule),
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
    };
}

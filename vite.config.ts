import {defineConfig} from "vite";
// import autoComponentsPlugin from "./src/plugins/vite-plugin-autocomponent";

export default defineConfig({
    server: {
        port: 5174,
    },
    build: {
        manifest: true,
        rolldownOptions: {
            input: "src/entry-client.ts",
        },
    },
    // plugins: [
    //     autoComponentsPlugin({
    //         componentsModule: './components', // chemin vers ton fichier qui exporte defineComponent
    //     }),
    // ],
})
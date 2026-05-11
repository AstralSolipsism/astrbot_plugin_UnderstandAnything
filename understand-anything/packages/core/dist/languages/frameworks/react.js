export const reactConfig = {
    id: "react",
    displayName: "React",
    languages: ["typescript", "javascript"],
    detectionKeywords: ["react", "react-dom", "@types/react"],
    manifestFiles: ["package.json"],
    promptSnippetPath: "./frameworks/react.md",
    entryPoints: ["src/App.tsx", "src/App.jsx", "src/index.tsx", "src/main.tsx"],
    layerHints: {
        components: "ui",
        hooks: "service",
        pages: "ui",
        contexts: "service",
        utils: "utility",
        lib: "service",
    },
};
//# sourceMappingURL=react.js.map
export const dockerfileConfig = {
    id: "dockerfile",
    displayName: "Dockerfile",
    extensions: [],
    filenames: ["Dockerfile", "Dockerfile.dev", "Dockerfile.prod", "Dockerfile.test"],
    concepts: ["multi-stage builds", "layers", "base images", "COPY/ADD", "EXPOSE", "ENTRYPOINT", "CMD", "ARG", "ENV"],
    filePatterns: {
        entryPoints: ["Dockerfile"],
        barrels: [],
        tests: [],
        config: [],
    },
};
//# sourceMappingURL=dockerfile.js.map
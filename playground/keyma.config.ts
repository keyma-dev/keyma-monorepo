import type { KeymaUserConfig } from "@keyma/compiler";

const config: KeymaUserConfig = {
    source: "src/**/*.ts",
    targets: [
        { language: "js", outDir: "dist/js" },
        { language: "python", outDir: "dist/python" },
        { language: "cpp", outDir: "dist/cpp", namespace: "playground" }
    ],
};

export default config;

import type { KeymaUserConfig } from "@keyma/compiler";

const config: KeymaUserConfig = {
    source: "src/**/*.ts",
    targets: [
        { language: "js", outDir: "dist/js", library: true },
    ],
};

export default config;

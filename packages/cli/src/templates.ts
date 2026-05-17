/** PascalCase the given identifier-ish string (e.g. "user-profile" → "UserProfile"). */
function pascalCase(name: string): string {
    return name
        .split(/[^a-zA-Z0-9]+/)
        .filter((part) => part.length > 0)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join("");
}

/** kebab-case the given identifier-ish string (e.g. "UserProfile" → "user-profile"). */
function kebabCase(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .toLowerCase()
        .replace(/^-+|-+$/g, "");
}

export type ProjectFile = { relativePath: string; content: string };

/** Files to write for `keyma new <name>`. */
export function projectFiles(projectName: string): ProjectFile[] {
    return [
        { relativePath: "package.json", content: packageJsonTemplate(projectName) },
        { relativePath: "tsconfig.json", content: TSCONFIG_TEMPLATE },
        { relativePath: "keyma.config.ts", content: KEYMA_CONFIG_TEMPLATE },
        { relativePath: "src/index.ts", content: INDEX_TS_TEMPLATE },
        { relativePath: "src/schemas/.gitkeep", content: "" },
    ];
}

/** Content for `keyma gen <name>`. The argument is taken as-is for the schema name. */
export function schemaTemplate(name: string): { relativePath: string; content: string } {
    const className = pascalCase(name);
    const schemaName = kebabCase(name) || name.toLowerCase();
    const content = `import { Schema, Validate, Indexed, isRequired, minLength, maxLength } from "@keyma/dsl";
import type { ID } from "@keyma/dsl";

@Schema({ name: "${schemaName}" })
export class ${className} {

    declare readonly id: ID;

    @Validate(isRequired, minLength(1), maxLength(255))
    declare name: string;
}
`;
    return { relativePath: `src/schemas/${schemaName}.ts`, content };
}

function packageJsonTemplate(projectName: string): string {
    const pkg = {
        name: projectName,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
            build: "keyma build",
            watch: "keyma watch",
            inspect: "keyma inspect",
        },
        dependencies: {
            "@keyma/dsl": "*",
            "@keyma/runtime-js": "*",
        },
        devDependencies: {
            "@keyma/cli": "*",
            typescript: "^5.7.0",
        },
    };
    return JSON.stringify(pkg, null, 2) + "\n";
}

const TSCONFIG_TEMPLATE = `{
    "compilerOptions": {
        "target": "ES2022",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "strict": true,
        "experimentalDecorators": true,
        "skipLibCheck": true,
        "outDir": "dist"
    },
    "include": ["src/**/*"]
}
`;

const KEYMA_CONFIG_TEMPLATE = `import type { KeymaUserConfig } from "@keyma/compiler";

const config: KeymaUserConfig = {
    source: "src/schemas/**/*.ts",
    targets: [
        { language: "js", outDir: "src/generated" },
    ],
};

export default config;
`;

const INDEX_TS_TEMPLATE = `// Entry point for your application.
// Schemas live under src/schemas/ and the compiler emits generated code into src/generated/.
export {};
`;

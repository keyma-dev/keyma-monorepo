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
        { relativePath: ".keyma/.gitkeep", content: "" }
    ];
}

/** Content for `keyma gen <name>`. The argument is taken as-is for the schema name. */
export function schemaTemplate(name: string): { relativePath: string; content: string } {
    const className = pascalCase(name);
    const schemaName = kebabCase(name) || name.toLowerCase();

    const parts = name.split(/[/\\]/).filter((p) => p.length > 0);
    const lastPart = parts.pop() || name;
    const fileName = kebabCase(lastPart) || lastPart.toLowerCase();
    const relativePath = ["src", ...parts, `${fileName}.ts`].join("/");

    const content = `import { ID, Schema, Validate, Indexed } from "@keyma/dsl";
import { required } from "@keyma/validators";

@Schema({ name: "${schemaName}" })
export class ${className} {

    declare readonly id: ID;
    
}
`;
    return { relativePath, content };
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
        },
        devDependencies: {
            "@keyma/cli": "*",
            "@keyma/dsl": "*",
            "@keyma/validators": "*",
            "@keyma/formatters": "*",
            typescript: "^6.0.3",
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
        "noEmit": true,
        "outDir": "dist"
    },
    "include": ["src/**/*"]
}
`;

const KEYMA_CONFIG_TEMPLATE = `import type { KeymaUserConfig } from "@keyma/compiler";

const config: KeymaUserConfig = {
    source: "src/**/*.ts",
    targets: [
        { language: "js", outDir: "dist/js" },
        { language: "python", outDir: "dist/python" },
    ],
};

export default config;
`;

const INDEX_TS_TEMPLATE = `// Entry point for your application.
// Schemas live under src/ and the compiler emits generated code into dist/{targetLang}/.
export {};
`;

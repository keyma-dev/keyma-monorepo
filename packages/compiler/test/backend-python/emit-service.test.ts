import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KeymaIR, IRService } from "@keyma/core/ir";
import { emitServicesPython, SERVICES_REF, type ServiceEmitDeps } from "../../src/backend-python/emit-service.js";
import { EMITTED_PY_RUNTIME_MODULE } from "../../src/backend-python/emitted-runtime.js";
import { createPythonBackend, type BuildClassData } from "../../src/backend-python/index.js";
import type { PythonTargetConfig } from "../../src/backend-python/types.js";

const SRC = { file: "user.ts", line: 1, column: 1 };

// A service: public methods create(data: User) -> User and get(id: ID) -> User, plus a private
// method purge() -> void; and a fully-private AdminService.
const userService: IRService = {
    id: "service:UserService",
    name: "UserService",
    sourceName: "UserService",
    visibility: "public",
    methods: [
        { name: "create", params: [{ name: "data", type: { kind: "instance", name: "User" } }], returnType: { kind: "instance", name: "User" }, visibility: "public", source: SRC },
        { name: "get", params: [{ name: "id", type: { kind: "id" } }], returnType: { kind: "instance", name: "User" }, visibility: "public", source: SRC },
        { name: "purge", params: [], visibility: "private", source: SRC },
    ],
    source: SRC,
};

const adminService: IRService = {
    id: "service:AdminService",
    name: "AdminService",
    sourceName: "AdminService",
    visibility: "private",
    methods: [{ name: "stats", params: [], returnType: { kind: "integer" }, visibility: "public", source: SRC }],
    source: SRC,
};

const deps = (includePrivate: boolean): ServiceEmitDeps => ({
    includePrivate,
    classModule: new Map([["User", "src/user/user"]]),
    classNameByName: new Map([["User", "User"]]),
});

describe("emitServicesPython — server bundle (abstract base + dispatch)", () => {
    const py = emitServicesPython([userService, adminService], deps(true));

    it("emits an abstract base class with service_name + per-method visibility", () => {
        assert.ok(py.includes("class UserService:"), py);
        assert.ok(py.includes('service_name = "UserService"'), py);
        assert.ok(py.includes('"create": {"private": False}'), py);
        assert.ok(py.includes('"purge": {"private": True}'), py);
    });

    it("private service carries service_private = True", () => {
        assert.ok(py.includes("class AdminService:"), py);
        assert.ok(py.includes("service_private = True"), py);
    });

    it("emits a generated dispatch that decodes args, awaits, and encodes the result", () => {
        assert.ok(py.includes("async def dispatch(self, method, payload, ctx, encoding):"), py);
        assert.ok(py.includes('if method == "create":'), py);
        assert.ok(py.includes('args = decode_args(encoding, [("data", {'), py);
        assert.ok(py.includes("result = self.create(*args, ctx)"), py);
        assert.ok(py.includes("if inspect.isawaitable(result):"), py);
        assert.ok(py.includes("return encode_result(encoding,"), py);
        assert.ok(py.includes('raise KeymaError(METHOD_NOT_FOUND'), py);
    });

    it("abstract methods inject ctx last and default to METHOD_NOT_IMPLEMENTED", () => {
        assert.ok(py.includes("async def create(self, data, ctx):"), py);
        assert.ok(py.includes("raise KeymaError(METHOD_NOT_IMPLEMENTED,"), py);
    });

    it("imports the codec/RPC helpers from the bundle-local baked module (no keyma-runtime)", () => {
        assert.ok(py.includes(`from .${EMITTED_PY_RUNTIME_MODULE} import`), py);
        assert.ok(py.includes("from .src.user.user import User"), py);
        assert.ok(!/^(from|import) keyma/m.test(py), "must not import a keyma package");
    });

    it("builds a _REFS map of referenced model classes", () => {
        assert.ok(py.includes('_REFS = {"User": User}'), py);
    });
});

describe("emitServicesPython — client bundle (transport-bound client)", () => {
    // Private services/methods are not visible in the client bundle.
    const py = emitServicesPython([userService, adminService], deps(false));

    it("emits a ServiceClient subclass with async methods marshalling via the baked module", () => {
        assert.ok(py.includes("class UserService(ServiceClient):"), py);
        assert.ok(py.includes('service_name = "UserService"'), py);
        assert.ok(py.includes("async def create(self, data):"), py);
        assert.ok(py.includes("args = encode_args(self._encoding,"), py);
        assert.ok(py.includes('result = await self._invoke("create", args)'), py);
        assert.ok(py.includes("return decode_result(self._encoding,"), py);
        assert.ok(py.includes(`from .${EMITTED_PY_RUNTIME_MODULE} import ServiceClient`), py);
    });

    it("omits private methods and private services", () => {
        assert.ok(!py.includes("async def purge"), py);
        assert.ok(!py.includes("AdminService"), py);
    });
});

// ── Full bundle shell: self-contained emission ───────────────────────────────────

const classMetadata: BuildClassData = (cls) => ({
    name: cls.name,
    sourceName: cls.sourceName,
    fields: cls.fields.map((f) => ({ name: f.name, type: f.type, required: f.required })),
});

const IR: KeymaIR = {
    irVersion: "1.0.0",
    compilerVersion: "0.1.0",
    classes: [
        {
            name: "User",
            sourceName: "User",
            visibility: "public",
            fields: [
                { name: "id", type: { kind: "id" }, visibility: "public", readonly: true, required: true, source: SRC },
                { name: "name", type: { kind: "string" }, visibility: "public", readonly: false, required: true, source: SRC },
            ],
            source: SRC,
        },
    ],
    services: [userService, adminService],
    diagnostics: [],
} as unknown as KeymaIR;

const TARGET: PythonTargetConfig = { language: "python", outDir: "dist/python", library: true } as PythonTargetConfig;
const CONFIG = { source: [], outDir: "dist", namePrefix: "", targets: [] };

describe("emitPython — self-contained service bundle", () => {
    it("emits the baked runtime module, services.py, and a service re-export — importing no keyma package", async () => {
        const backend = createPythonBackend({ classMetadata });
        const result = await backend.emit(IR, TARGET as never, CONFIG as never);
        const byPath = new Map(result.files.map((f) => [f.path, f.content as string]));

        assert.ok(byPath.has(`dist/python/${EMITTED_PY_RUNTIME_MODULE}.py`), "baked runtime module missing");
        assert.ok(byPath.has(`dist/python/${SERVICES_REF}.py`), "services.py missing");

        const index = byPath.get("dist/python/index.py")!;
        assert.ok(index.includes("from .services import AdminService, UserService"), index);

        // Self-containment: no generated .py imports a keyma package.
        for (const [p, content] of byPath) {
            if (!p.endsWith(".py")) continue;
            assert.ok(!/^(from|import) keyma/m.test(content), `${p} imports a keyma package:\n${content}`);
        }

        // The baked module is genuine self-contained Python (top-level future import + stdlib only).
        const baked = byPath.get(`dist/python/${EMITTED_PY_RUNTIME_MODULE}.py`)!;
        assert.ok(baked.includes("def serialize("), baked.slice(0, 200));
        assert.ok(baked.includes("class ServiceHost:"), "baked module missing ServiceHost");
    });
});

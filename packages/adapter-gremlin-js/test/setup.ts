import gremlin from "gremlin";
import type { GraphTraversal, GraphTraversalSource } from "../src/gremlin.js";

const { DriverRemoteConnection } = gremlin.driver;
const { AnonymousTraversalSource, GraphTraversalSource, TraversalStrategies, Bytecode, Translator } =
    gremlin.process;
const { Graph } = gremlin.structure;

/** Integration tests run only against a live Gremlin server. Set
 *  GREMLIN_ENDPOINT (e.g. ws://localhost:8182/gremlin) to enable them; they are
 *  skipped otherwise. Spin one up locally with:
 *    docker run -p 8182:8182 tinkerpop/gremlin-server */
export const ENDPOINT = process.env["GREMLIN_ENDPOINT"];
export const hasServer = ENDPOINT !== undefined && ENDPOINT !== "";

export type LiveHandle = {
    conn: InstanceType<typeof DriverRemoteConnection>;
    g: GraphTraversalSource;
};

export async function connect(): Promise<LiveHandle> {
    const conn = new DriverRemoteConnection(ENDPOINT as string, {});
    const g = AnonymousTraversalSource.traversal().withRemote(conn) as GraphTraversalSource;
    return { conn, g };
}

export async function close(h: LiveHandle): Promise<void> {
    await h.conn.close();
}

export async function clean(h: LiveHandle): Promise<void> {
    await (h.g.V().drop() as GraphTraversal).iterate();
}

/** A graph-less, bytecode-recording traversal source for unit tests — building
 *  steps records bytecode without contacting any server. */
export function bytecodeSource(): GraphTraversalSource {
    return new GraphTraversalSource(
        new Graph(),
        new TraversalStrategies(),
        new Bytecode(),
    ) as unknown as GraphTraversalSource;
}

/** Render a built traversal to its canonical Gremlin string for assertions. */
export function translate(trav: GraphTraversal): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bytecode = (trav as unknown as { getBytecode(): any }).getBytecode();
    return new Translator("g").translate(bytecode);
}
